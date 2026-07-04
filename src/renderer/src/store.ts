// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer-side live editing state. The EditorController (in @core) is the single source of
// truth for the timeline + undo/redo; this store mirrors its snapshot for React rendering and
// owns the things the controller doesn't: project IO, the media bin, and FFmpeg status.
//
// Editing commands are issued through `getController()` (UI, and later the in-app agent + MCP
// server, all call the same commands). The subscription below pushes every change back here.

import {
  type AudioEnhanceSettings,
  type Clip,
  type ClipboardPayload,
  type CommandOrigin,
  Defaults,
  EditorController,
  type EditorChangeKind,
  type MediaManifest,
  type MediaManifestEntry,
  type Timeline,
  type ToolCallResult,
  type Track,
  type TrackRole,
  type PlannedCut,
  type PlannedTake,
  alignByTranscript,
  buildTakeTimeline,
  clipEndFrame,
  clipSourceSecondsAt,
  cutRangeToAnglesByTrack,
  expectedPath,
  makeManifest,
  makeTimeline,
  newId,
  presetById,
  resolvePasteTargets,
  serializeSelection,
  splitScriptBlocks,
  totalFrames
} from '@core'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { PROJECT_SCHEMA_VERSION, type ExportQuality, type FfmpegStatus, type ImportedAsset, type TranscriptWord } from '../../shared/ipc'

// ── Sessions (tabs) ───────────────────────────────────────────────────────────────────────────
// Each open project is a Session with its own EditorController. The reactive store below ALWAYS
// mirrors the ACTIVE session; switching tabs saves the outgoing session's per-project fields and
// loads the incoming one's. React components read the store unchanged (they see the active session).
interface Session {
  id: string
  /** Short tab label (e.g. the take title). */
  name: string
  controller: EditorController
  projectDir: string | null
  projectName: string
  createdAt: string
  manifest: MediaManifest
  thumbnails: Record<string, string | null>
  transcript: TranscriptWord[] | null
  exportQuality: ExportQuality
  dirty: boolean
}

function makeSession(init: {
  name?: string
  timeline?: Timeline
  projectDir?: string | null
  projectName?: string
  createdAt?: string
  manifest?: MediaManifest
  exportQuality?: ExportQuality
} = {}): Session {
  return {
    id: newId(),
    name: init.name ?? 'Proyecto 1',
    controller: new EditorController(init.timeline),
    projectDir: init.projectDir ?? null,
    projectName: init.projectName ?? init.name ?? 'Untitled Project',
    createdAt: init.createdAt ?? new Date().toISOString(),
    manifest: init.manifest ?? makeManifest(),
    thumbnails: {},
    transcript: null,
    exportQuality: init.exportQuality ?? 'veryHigh',
    dirty: false
  }
}

let sessions: Session[] = [makeSession()]
let activeId = sessions[0].id

function activeSession(): Session {
  return sessions.find((s) => s.id === activeId) ?? sessions[0]
}

/** The ACTIVE session's editing brain. UI components call commands on this directly. */
export function getController(): EditorController {
  return activeSession().controller
}

/** Create a new session (tab) from a ready timeline + manifest and register its tab. Returns its id.
 *  Does NOT switch to it — call `loadSessionIntoStore` after. `projectDir` MUST be inherited from the
 *  parent so project-relative media (proxies, enhanced audio) and export-per-tab resolve correctly. */
function openSession(name: string, timeline: Timeline, manifest: MediaManifest, projectDir: string | null): string {
  const sess = makeSession({ name, projectName: name, timeline, manifest: structuredClone(manifest), projectDir })
  subscribeSession(sess)
  sessions.push(sess)
  useEditorStore.setState((s) => {
    s.tabs.push({ id: sess.id, name: sess.name, dirty: false })
  })
  return sess.id
}

/** Session clipboard for clip copy/paste. Module-scoped (not undoable, not persisted);
 *  `hasClipboard` mirrors its presence into the store so menus can enable "Pegar". */
let clipboard: ClipboardPayload | null = null

// ── Frame capturer (get_frame_preview) ───────────────────────────────────────────────────────────
// The Preview component registers a function that captures its composited canvas (letterboxed
// project region only) after in-flight seeks settle. Module-scoped: it's a live function, not state.

export interface FrameCaptureOptions {
  maxWidth: number
  format: 'png' | 'jpeg'
}
export interface FrameCaptureResult {
  dataUrl: string
  width: number
  height: number
}
export type FrameCapturer = (opts: FrameCaptureOptions) => Promise<FrameCaptureResult | null>

let frameCapturer: FrameCapturer | null = null
export function setFrameCapturer(fn: FrameCapturer | null): void {
  frameCapturer = fn
}
export function getFrameCapturer(): FrameCapturer | null {
  return frameCapturer
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function projectNameFromPath(p: string): string {
  return baseName(p).replace(/\.vproj$/i, '')
}

/** On first import (while the user hasn't set resolution/fps), match the project to the first video's
 *  source so the export isn't silently downscaled to the 1080p/30 default — addressing "the export
 *  weighs much less than the raw". A manual resolution/fps change marks settings configured and wins. */
function maybeAdoptProjectSettings(imported: ImportedAsset[]): void {
  if (getController().getTimeline().settingsConfigured) return
  const v = imported.find(
    (a) => a.entry.type === 'video' && (a.entry.sourceWidth ?? 0) > 0 && (a.entry.sourceHeight ?? 0) > 0
  )
  if (!v) return
  const srcFps = v.entry.sourceFPS && v.entry.sourceFPS > 0 ? Math.round(v.entry.sourceFPS) : getController().getTimeline().fps
  // x264 + yuv420p require even dimensions; round down so an odd-sized source can't break the export.
  const even = (n: number): number => (n % 2 === 0 ? n : n - 1)
  getController().setProjectSettings(even(v.entry.sourceWidth as number), even(v.entry.sourceHeight as number), srcFps)
}

/** Full-length clip duration (frames) for a freshly dropped asset at the project fps. */
export function defaultClipFramesForAsset(entry: MediaManifestEntry, fps: number): number {
  switch (entry.type) {
    case 'video':
    case 'audio':
    case 'lottie':
      return Math.max(1, Math.round((entry.duration || Defaults.imageDurationSeconds) * fps))
    case 'image':
      return Math.max(1, Math.round(Defaults.imageDurationSeconds * fps))
    case 'text':
      return Math.max(1, Math.round(Defaults.textDurationSeconds * fps))
  }
}

/** Min seconds between adjacent angle-cut candidates (fused across pauses + intensity peaks). */
const ANGLE_MIN_GAP_SEC = 1.0

/** Apply a previewed angle-cut plan: split every angle track per segment and show the chosen angle
 *  (by its role → trackId). Works for 2 or 3 angles. One undo step. Returns how many segments were
 *  applied vs skipped (a segment is skipped when the angle tracks aren't aligned at that frame), so
 *  the caller can tell the user instead of failing silently. */
function applyPlanCuts(c: EditorController, plan: AnglePlan): { applied: number; skipped: number } {
  const roleToTrack = new Map<TrackRole, string>()
  for (const a of plan.angleTracks) roleToTrack.set(a.role, a.trackId)
  const trackIds = plan.angleTracks.map((a) => a.trackId)
  let applied = 0
  let skipped = 0
  c.runAs('user', () =>
    c.transact('Auto Ángulos (multicam)', () => {
      for (const seg of plan.segments) {
        if (seg.endFrame <= seg.startFrame) continue
        const chosenTrackId = roleToTrack.get(seg.role) ?? trackIds[0]
        const chosenIndex = chosenTrackId ? trackIds.indexOf(chosenTrackId) : -1
        if (chosenIndex < 0) {
          skipped++
          continue
        }
        // Isolate the range across ALL clips of each angle track (whole-track cuts straddle clip
        // boundaries). Returns false (skip) when fewer than two angle tracks have clips in the range.
        const ok = cutRangeToAnglesByTrack(c, trackIds, chosenIndex, seg.startFrame, seg.endFrame, plan.destructive)
        if (ok) applied++
        else skipped++
      }
    })
  )
  return { applied, skipped }
}

/** Pick the clip on a track used as the cut base / for analysis: the selected clip if one lives here,
 *  else the first clip. */
function baseClipOf(track: Track, selectedIds: string[]): Clip | null {
  return track.clips.find((cl) => selectedIds.includes(cl.id)) ?? track.clips[0] ?? null
}

/** Assign one DISTINCT role per angle track (timeline top→bottom order): honor explicit F/L/B tags
 *  first, then frontal = topmost untagged, then fill lateral → broll. Returns a trackId→role map. */
function assignAngleRoles(order: Track[]): Map<string, TrackRole> {
  const roleOf = new Map<string, TrackRole>()
  const available: TrackRole[] = ['frontal', 'lateral', 'broll']
  const used = (): Set<TrackRole> => new Set(roleOf.values())
  for (const t of order) {
    if (t.role && available.includes(t.role) && !used().has(t.role)) roleOf.set(t.id, t.role)
  }
  if (!used().has('frontal')) {
    const firstUntagged = order.find((t) => !roleOf.has(t.id))
    if (firstUntagged) roleOf.set(firstUntagged.id, 'frontal')
  }
  for (const t of order) {
    if (roleOf.has(t.id)) continue
    roleOf.set(t.id, available.find((r) => !used().has(r)) ?? 'lateral')
  }
  return roleOf
}

/** Build the angle-cut plan: resolve the 2-3 SELECTED video tracks, assign distinct roles, transcribe
 *  the primary (frontal) angle, analyze each angle's volume, fuse the frontal's pauses + peaks into cut
 *  candidates, and assign a role per segment via the semantic rules. Drives the progress modal. Returns
 *  `{ ok, plan }` (plan undefined ⇒ no cuts). Does NOT apply. */
async function buildAnglePlan(
  get: () => EditorState,
  destructive: boolean
): Promise<{ ok: boolean; plan?: AnglePlan; error?: string }> {
  const c = getController()
  const { manifest, projectDir } = get()
  let transcript = get().transcript

  // 1. Resolve the 2-3 selected video tracks (in timeline top→bottom order).
  const tl0 = c.getTimeline()
  const selectedIds = c.getSelectedClipIds()
  const selectedVideoTrackIds = new Set<string>()
  for (const id of selectedIds) {
    const t = c.getTrackOfClip(id)
    if (t && t.type === 'video') selectedVideoTrackIds.add(t.id)
  }
  const order = tl0.tracks.filter((t) => t.type === 'video' && selectedVideoTrackIds.has(t.id))
  if (order.length < 2 || order.length > 3) {
    alert('Cambios de ángulo: selecciona clips en 2 o 3 pistas de video (frontal, lateral y opcional b-roll).')
    return { ok: false, error: 'Selecciona 2 o 3 pistas de video.' }
  }

  // 2. Distinct roles per track + the frontal (primary) track/clip.
  const roleOf = assignAngleRoles(order)
  const frontalTrack = order.find((t) => roleOf.get(t.id) === 'frontal') ?? order[0]
  const frontalBase = baseClipOf(frontalTrack, selectedIds)
  if (!frontalBase || (frontalBase.mediaType !== 'video' && frontalBase.mediaType !== 'audio')) {
    alert('La pista frontal no tiene un clip de video válido para procesar.')
    return { ok: false, error: 'La pista frontal no tiene un clip válido.' }
  }
  const path = expectedPath(manifest, frontalBase.mediaRef, projectDir)
  if (!path) {
    alert('El archivo del clip frontal no se encuentra en el disco.')
    return { ok: false, error: 'El medio del clip frontal está offline.' }
  }
  const videoTracks = tl0.tracks.filter((t) => t.type === 'video')
  const labelOf = (id: string): string => `V${videoTracks.findIndex((t) => t.id === id) + 1}`

  get().startProgress('Análisis de cambios de ángulo', [
    { id: 'transcribe', label: 'Transcribir audio (ElevenLabs Scribe)' },
    { id: 'silences', label: 'Analizar volumen de cada ángulo (RMS)' },
    { id: 'peaks', label: 'Fusionar pausas + picos en candidatos' },
    { id: 'segment', label: 'Mapear segmentos y reglas semánticas' }
  ])

  // 3. Transcript of the primary (frontal) angle.
  if (!transcript || transcript.length === 0) {
    get().setStep('transcribe', 'active')
    const res = await get().transcribeClip(frontalBase.id, { languageCode: 'es' })
    if (!res.ok) {
      get().setStep('transcribe', 'error', res.error)
      get().finishProgress('No se pudo transcribir: ' + res.error)
      return { ok: false, error: 'Transcription failed: ' + res.error }
    }
    transcript = get().transcript
    if (!transcript) {
      get().setStep('transcribe', 'error', 'Transcripción vacía')
      get().finishProgress('La transcripción devolvió vacío.')
      return { ok: false, error: 'La transcripción devolvió vacío.' }
    }
    get().setStep('transcribe', 'done', `${transcript.length} palabras`)
  } else {
    get().setStep('transcribe', 'done', '(ya disponible)')
  }

  const fps = c.getTimeline().fps

  // WHOLE-TRACK analysis. The frontal track is usually cut into many clips (the user removed bad takes),
  // so we span ALL of them, not one base clip. Each UNIQUE source feeding the track is decoded once and
  // its pauses/peaks are mapped to timeline frames THROUGH the clip that exposes them — a pause/peak in a
  // region the user trimmed out maps to nothing and is dropped. Cut candidates therefore cover the entire
  // track. (`analyzeIntensity` uses a RELATIVE threshold, so quiet raw audio still works.)
  const frontalClips = [...frontalTrack.clips].sort((a, b) => a.startFrame - b.startFrame)
  const spanStart = frontalClips[0].startFrame
  const spanEnd = Math.max(...frontalClips.map((cl) => clipEndFrame(cl)))

  type Intensity = Awaited<ReturnType<typeof window.editorBridge.analyzeIntensity>>
  const intensityBySource = new Map<string, Intensity | null>()
  const analyzeSource = async (mediaRef: string): Promise<Intensity | null> => {
    if (intensityBySource.has(mediaRef)) return intensityBySource.get(mediaRef) ?? null
    const p = expectedPath(manifest, mediaRef, projectDir)
    const r = p ? await window.editorBridge.analyzeIntensity(p) : null
    intensityBySource.set(mediaRef, r)
    return r
  }

  get().setStep('silences', 'active')

  // Frontal: fuse every frontal clip's source pauses+peaks into TIMELINE-frame cut candidates.
  const srcSecToTimelineFrame = (clip: Clip, sec: number): number =>
    clip.startFrame + Math.round((Math.round(sec * fps) - clip.trimStartFrame) / clip.speed)
  const candidates: { frame: number; trigger: 'pausa' | 'pico' }[] = []
  let frontalEnvSource: Intensity | null = null
  for (const cl of frontalClips) {
    const r = await analyzeSource(cl.mediaRef)
    if (cl.id === frontalBase.id) frontalEnvSource = r
    if (!r || !r.ok) continue
    const tagged: { sec: number; trigger: 'pausa' | 'pico' }[] = [
      ...(r.pauses ?? []).map((sec) => ({ sec, trigger: 'pausa' as const })),
      ...(r.peaks ?? []).map((sec) => ({ sec, trigger: 'pico' as const }))
    ]
    for (const t of tagged) {
      const frame = srcSecToTimelineFrame(cl, t.sec)
      if (frame > cl.startFrame && frame < clipEndFrame(cl)) candidates.push({ frame, trigger: t.trigger })
    }
  }
  // Envelope graph source for the frontal angle: its base clip's source, else any frontal source that
  // decoded OK.
  if (!frontalEnvSource || !frontalEnvSource.ok) {
    frontalEnvSource = [...intensityBySource.values()].find((r): r is Intensity => !!r && r.ok) ?? frontalEnvSource
  }
  if (candidates.length === 0 && (!frontalEnvSource || !frontalEnvSource.ok)) {
    get().setStep('silences', 'error', frontalEnvSource?.error ?? 'sin audio')
    get().finishProgress('Error al analizar el audio frontal: ' + (frontalEnvSource?.error ?? ''))
    return { ok: false, error: frontalEnvSource?.error ?? 'Análisis de audio fallido' }
  }

  // Every angle gets one representative decode purely for the preview envelope graph; only the frontal's
  // candidates drive the cuts.
  const angleTracks: AnglePlanAngle[] = []
  for (const t of order) {
    const role = roleOf.get(t.id) ?? 'frontal'
    const base = baseClipOf(t, selectedIds)
    const r = t.id === frontalTrack.id ? frontalEnvSource : base ? await analyzeSource(base.mediaRef) : null
    angleTracks.push({
      trackId: t.id,
      clipId: base?.id ?? '',
      role,
      label: labelOf(t.id),
      envelope: r?.ok ? r.envelope ?? [] : [],
      peaks: r?.ok ? r.peaks ?? [] : [],
      pauses: r?.ok ? r.pauses ?? [] : []
    })
  }
  // Keep angleTracks frontal-first (primary), then by timeline order.
  angleTracks.sort((a, b) => (a.role === 'frontal' ? -1 : b.role === 'frontal' ? 1 : 0))
  get().setStep('silences', 'done', `${order.length} ángulos`)
  get().setStep('peaks', 'active')

  // Dedup candidates within ANGLE_MIN_GAP_SEC (earliest wins), in TIMELINE space.
  const minGapFrames = Math.round(ANGLE_MIN_GAP_SEC * fps)
  candidates.sort((a, b) => a.frame - b.frame)
  const cutPts: { frame: number; trigger: 'pausa' | 'pico' }[] = []
  for (const cand of candidates) {
    if (cutPts.length === 0 || cand.frame - cutPts[cutPts.length - 1].frame >= minGapFrames) cutPts.push(cand)
  }
  get().setStep('peaks', 'done', `${cutPts.length} candidatos`)

  if (cutPts.length === 0) {
    get().setStep('segment', 'done', '0 cortes')
    get().finishProgress()
    return { ok: true } // no pauses/peaks detected → nothing to cut (analyzeAutoAngles warns the user)
  }

  // Build segments between cut points over the WHOLE track span and assign an angle so EVERY cut is a
  // REAL change. Frontal is "home": even segments stay frontal, odd segments cut to the next alternative
  // angle (lateral, then b-roll) and the following segment returns to frontal — visible alternation at
  // every detected point.
  get().setStep('segment', 'active')
  const nonFrontalRoles = angleTracks.map((a) => a.role).filter((r) => r !== 'frontal')
  const boundaryFrames = [spanStart, ...cutPts.map((p) => p.frame), spanEnd]
  // Best-effort caption text per segment: map the timeline range back to source seconds via the frontal
  // clip covering it, but only when that clip shares the transcribed (primary) source.
  const textForRange = (startFrame: number, endFrame: number): string => {
    if (!transcript) return ''
    const cl = frontalClips.find((k) => startFrame >= k.startFrame && startFrame < clipEndFrame(k))
    if (!cl || cl.mediaRef !== frontalBase.mediaRef) return ''
    const s0 = clipSourceSecondsAt(cl, startFrame, fps)
    const s1 = clipSourceSecondsAt(cl, Math.min(endFrame - 1, clipEndFrame(cl) - 1), fps)
    return transcript
      .filter((w) => w.startMs / 1000 >= s0 && w.startMs / 1000 < s1)
      .map((w) => w.text)
      .join(' ')
  }
  const segments: AnglePlanSegment[] = []
  let altIdx = 0
  for (let i = 0; i < boundaryFrames.length - 1; i++) {
    const startFrame = boundaryFrames[i]
    const endFrame = boundaryFrames[i + 1]
    let role: TrackRole = 'frontal'
    if (i % 2 === 1 && nonFrontalRoles.length > 0) role = nonFrontalRoles[altIdx++ % nonFrontalRoles.length]
    segments.push({
      startSec: startFrame / fps,
      endSec: endFrame / fps,
      startFrame,
      endFrame,
      role,
      trigger: i === 0 ? undefined : cutPts[i - 1].trigger,
      text: textForRange(startFrame, endFrame)
    })
  }

  get().setStep('segment', 'done', `${segments.length - 1} cambios de ángulo`)
  get().dismissProgress()

  const plan: AnglePlan = {
    fps,
    durationSec: spanEnd / fps,
    angleTracks,
    segments,
    destructive
  }
  return { ok: true, plan }
}

/** Per-source transcript cache (by mediaRef) so "Limpiar tomas" + "Sincronizar" don't re-transcribe the
 *  same file. Source files don't change (cleaning only rearranges timeline clips), so the cache stays valid. */
const transcriptCache = new Map<string, TranscriptWord[]>()

async function transcribeCached(mediaPath: string, mediaRef: string): Promise<TranscriptWord[] | null> {
  const hit = transcriptCache.get(mediaRef)
  if (hit) return hit
  const res = await window.editorBridge.transcribeMedia({ mediaPath, languageCode: 'es' })
  if (!res.ok || !res.words) return null
  transcriptCache.set(mediaRef, res.words)
  return res.words
}

/** Result of the audio-offset analysis (drives the sync confirmation modal). */
export interface SyncResultState {
  ok: boolean
  offsetSeconds?: number
  offsetFrames?: number
  confidence?: number
  reliable?: boolean
  /** How the offset was found: matched transcript words (precise) or RMS cross-correlation (fallback). */
  method?: 'transcript' | 'audio'
  frontalClipId?: string
  lateralClipId?: string
  error?: string
}

export interface ApplySyncOptions {
  frontalClipId: string
  lateralClipId: string
  offsetSeconds: number
  keepAudioOf: 'frontal' | 'lateral'
  autoColor: boolean
}

export interface SyncAnglesInput {
  clipIds?: string[]
  keepAudioOf?: 'first' | 'second'
  autoColor?: boolean
}

/** Live progress of a long-running operation (drives the progress modal). */
export type ProgressStatus = 'pending' | 'active' | 'done' | 'error'
export interface ProgressStep {
  id: string
  label: string
  status: ProgressStatus
  detail?: string
}
export interface OpProgress {
  title: string
  steps: ProgressStep[]
  /** Raw backend output lines (FFmpeg / ElevenLabs), capped to the most recent 500. */
  log: string[]
  done: boolean
  error?: string
}

/** One segment of a proposed angle-cut plan (between two candidate cut points). */
export interface AnglePlanSegment {
  /** Source-audio seconds (for the waveform preview). */
  startSec: number
  endSec: number
  /** Timeline frames (for applying the cut + drawing timeline marks). */
  startFrame: number
  endFrame: number
  /** Which angle (by multicam role) to show. Resolved to a trackId at apply time, so changing a
   *  track's role in the preview re-targets every segment without recomputing the plan. */
  role: TrackRole
  /** What triggered the cut that OPENS this segment ('pausa' = silence, 'pico' = emphasis peak);
   *  undefined for the first segment (no cut before it). Shown in the preview for transparency. */
  trigger?: 'pausa' | 'pico'
  text: string
}

/** One angle (video track) participating in the plan, with its own volume analysis for the graphs. */
export interface AnglePlanAngle {
  trackId: string
  /** The clip on this track used as the cut base / for analysis. */
  clipId: string
  role: TrackRole
  /** Display label like "V1". */
  label: string
  /** Normalized 0..1 loudness envelope of THIS angle's audio (for its waveform graph). */
  envelope: number[]
  /** Emphasis peak times (seconds). */
  peaks: number[]
  /** Pause midpoint times (seconds). */
  pauses: number[]
}

/** A previewable plan of where the angle changes will happen, shown before the cuts are applied. */
export interface AnglePlan {
  fps: number
  durationSec: number
  /** The 2-3 angle tracks (timeline top→bottom order). angleTracks[0] is the primary (frontal)
   *  whose audio drove the cut candidates. */
  angleTracks: AnglePlanAngle[]
  segments: AnglePlanSegment[]
  destructive: boolean
}

/** A reviewable "take detection" plan: the raw clip's transcript segmented into takes (guiones) plus
 *  the spans to cut, awaiting user confirmation before each accepted take is built + exported. Mirrors
 *  the `anglePlan` preview-then-apply pattern. Times are absolute SOURCE ms (from the transcript). */
export interface TakesPlanState {
  takes: PlannedTake[]
  cuts: PlannedCut[]
  durationMs: number
  /** The raw clip on the live timeline these takes are carved from. */
  rawClipId: string
  rawMediaRef: string
  /** Project fps at analysis time (ms→frame conversion). */
  fps: number
  /** UI: per-take accept flag, index-aligned with `takes`. */
  takeAccepted: boolean[]
  /** UI: per-cut accept flag, index-aligned with `cuts`. Aggressive default: all on. */
  cutAccepted: boolean[]
  /** The pasted guiones split into blocks (script-driven mode) — for the verification UI to show the
   *  expected text per take, paired via `PlannedTake.scriptIndex`. Empty in inference mode. */
  scriptBlocks: string[]
}

export interface EditorState {
  // Mirrored from the controller (read-only for components).
  timeline: Timeline
  currentFrame: number
  selectedClipIds: string[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null

  // Owned here.
  projectDir: string | null
  projectName: string
  createdAt: string
  manifest: MediaManifest
  /** Session-only base64 thumbnails keyed by asset id (regenerated on open). */
  thumbnails: Record<string, string | null>
  ffmpeg: FfmpegStatus | null
  busy: string | null
  dirty: boolean
  lastError: string | null
  /** Export quality tier (UI-selectable); mapped to a CRF host-side. */
  exportQuality: ExportQuality
  /** 0..1 while an export renders, else null — drives the blocking export overlay. */
  exportProgress: number | null
  /** Set when an export finishes (ok with path, or error) — drives the confirmation modal. */
  exportResult: { ok: boolean; outputPath?: string; error?: string } | null
  /** True while audio-offset analysis runs — drives the sync analysis spinner. */
  syncBusy: boolean
  /** Detected offset (or error) — drives the sync confirmation modal. */
  syncResult: SyncResultState | null
  /** True while ElevenLabs transcription is running. */
  transcribing: boolean
  /** Transcript from the last `transcribeClip` call (words with ms timestamps). */
  transcript: TranscriptWord[] | null
  /** Live progress of the current long-running op (auto-angles), or null — drives the progress modal. */
  progress: OpProgress | null
  /** Proposed angle-cut plan awaiting user confirmation, or null — drives the preview modal + timeline marks. */
  anglePlan: AnglePlan | null
  /** True while the LLM take-detection analysis runs. */
  analyzingTakes: boolean
  /** Detected take/cut plan awaiting confirmation, or null — drives the take review modal. */
  takesPlan: TakesPlanState | null
  /** True while the Preview transport is playing. Lifted here so the Timeline can follow the playhead. */
  isPlaying: boolean
  /** True when the session clipboard holds clips (enables "Pegar" in menus/shortcuts). */
  hasClipboard: boolean
  /** Color grading modal visibility. Store-owned so the toolbar AND the clip context menu can open it. */
  colorInspectorOpen: boolean
  /** Audio enhance modal visibility (same reason). */
  audioInspectorOpen: boolean
  /** Active tab of the right column: the AI chat or the clip properties inspector. */
  rightTab: 'chat' | 'props'
  /** Open project tabs (sessions). The mirrored fields above reflect the ACTIVE tab. */
  tabs: { id: string; name: string; dirty: boolean }[]
  activeTabId: string
  /** True while the take-detection input modal (pegar guiones) is open. */
  takesInputOpen: boolean

  init: () => Promise<void>
  newProject: () => void
  /** Switch the active project tab. */
  switchSession: (id: string) => void
  /** Close a project tab (recreates a blank one if it was the last). */
  closeSession: (id: string) => void
  /** Open/close the "pegar guiones" input modal (take detection). */
  setTakesInputOpen: (open: boolean) => void
  importFiles: () => Promise<void>
  importFromSources: (sources: string[]) => Promise<ImportedAsset[]>
  saveProject: () => Promise<void>
  openProject: () => Promise<void>
  exportProject: () => Promise<void>
  /** Render to a given path without a dialog — used by the AI `export` tool (and MCP). */
  exportToPath: (outputPath: string) => Promise<ToolCallResult>
  setResolution: (width: number, height: number) => void
  setFps: (fps: number) => void
  setExportQuality: (q: ExportQuality) => void
  dismissExportResult: () => void
  revealExport: (filePath: string) => void
  /** Extract a video clip/asset's audio into a new bin asset. */
  extractAudioFromClip: (clipOrAssetId: string) => Promise<ToolCallResult>
  /** Voice-cleanup an AUDIO clip's audio (re-render via FFmpeg) and replace its media in place. */
  enhanceClipAudio: (clipId: string, settings?: Partial<AudioEnhanceSettings>) => Promise<ToolCallResult>
  /** AI voice isolation (ElevenLabs): clean an AUDIO clip's source (remove noise/music/reverb) and
   *  replace its media in place. The destructive ML pass; the per-clip `audioEnhance` DSP shapes tone on
   *  top. `intensity` (0..1) is the CapCut-style dry/wet blend; `denoise` (0..1) kills a constant
   *  background fan via an afftdn pass after isolation. */
  isolateClipVoice: (clipId: string, intensity?: number, denoise?: number) => Promise<ToolCallResult>
  /** Generate preview proxies (1080p H.264) for every video asset lacking one → smooth, seekable preview. */
  optimizePlayback: () => Promise<ToolCallResult>
  /** Analyze the two selected video clips' audio offset → opens the sync confirmation modal. */
  analyzeSyncForSelection: () => Promise<void>
  /** Apply a multicam sync: align both angles on two video tracks, single shared audio track, optional per-angle color. */
  applySyncAngles: (opts: ApplySyncOptions, origin?: CommandOrigin) => Promise<ToolCallResult>
  /** AI/MCP entry: compute the offset then apply, in one go. */
  syncAnglesTool: (input: SyncAnglesInput) => Promise<ToolCallResult>
  dismissSyncResult: () => void
  /** Transcribe a clip (or asset) using ElevenLabs Scribe. Returns word-level timestamps. */
  transcribeClip: (clipOrAssetId: string, opts?: { languageCode?: string; diarize?: boolean }) => Promise<ToolCallResult>
  clearTranscript: () => void
  /** Re-export the current transcript as a plain .srt subtitle file via save dialog. */
  exportTranscriptSrt: () => Promise<void>
  /** Analiza (transcript + pausas + picos) y abre la previsualización del plan de cortes (no corta aún). */
  analyzeAutoAngles: (opts?: { destructive?: boolean }) => Promise<ToolCallResult>
  /** Aplica el plan de cortes previsualizado (`anglePlan`) y lo limpia. */
  applyAnglePlan: () => void
  /** Reasigna el rol (Frontal/Lateral/B-roll) de una pista del plan, manteniéndolos distintos (swap). */
  setAnglePlanRole: (trackId: string, role: TrackRole) => void
  /** Cambia el modo del plan: destructivo (elimina los fragmentos no elegidos) vs no destructivo (opacity 0). */
  setAnglePlanDestructive: (destructive: boolean) => void
  /** Descarta el plan de cortes previsualizado sin aplicar. */
  dismissAnglePlan: () => void
  /** Analiza el transcript de un clip crudo (transcribe si hace falta) y abre el plan de tomas (no aplica).
   *  `cleanCuts` (default false) activa el corte de muletillas/repeticiones/silencios; apagado trae el
   *  fragmento completo de cada guión sin cortes. */
  analyzeTakes: (clipOrAssetId?: string, scripts?: string, cleanCuts?: boolean) => Promise<ToolCallResult>
  /** Construye la Timeline limpia de cada toma aceptada y exporta un MP4 por toma. */
  applyTakesPlan: () => Promise<void>
  /** Marca/desmarca una toma (por su posición en `takes`). */
  setTakeAccepted: (takeArrayIndex: number, accepted: boolean) => void
  /** Marca/desmarca un corte (por su posición en `cuts`). */
  setCutAccepted: (cutArrayIndex: number, accepted: boolean) => void
  /** Descarta el plan de tomas sin exportar. */
  dismissTakesPlan: () => void
  /** Set by the Preview transport when play/pause toggles (so the Timeline can auto-follow the playhead). */
  setPlaying: (playing: boolean) => void
  /** Toggle playback from anywhere (Space, preview click, transport button). Restarts from 0 when the
   *  playhead sits at the end; no-op on an empty timeline. */
  togglePlayback: () => void
  /** Copy the selected clips to the session clipboard. */
  copySelection: () => void
  /** Copy the selected clips, then remove them (one undo step). */
  cutSelection: () => void
  /** Paste the clipboard at `frame` (default: playhead), creating tracks when needed. Selects the copies. */
  pasteAtFrame: (frame?: number) => void
  /** Duplicate the selected clips right after their own end (one undo step). Selects the copies. */
  duplicateSelection: () => void
  setColorInspectorOpen: (open: boolean) => void
  setAudioInspectorOpen: (open: boolean) => void
  setRightTab: (tab: 'chat' | 'props') => void
  /** One-shot (agente/MCP): analiza y aplica los cortes de inmediato, sin previsualización. */
  applyAutoAngles: (opts?: { destructive?: boolean }) => Promise<ToolCallResult>
  // Progress modal controls.
  startProgress: (title: string, steps: { id: string; label: string }[]) => void
  setStep: (id: string, status: ProgressStatus, detail?: string) => void
  appendProgressLog: (line: string) => void
  finishProgress: (error?: string) => void
  dismissProgress: () => void
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    timeline: getController().getTimeline(),
    currentFrame: 0,
    selectedClipIds: [],
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,

    projectDir: null,
    projectName: 'Untitled Project',
    createdAt: new Date().toISOString(),
    manifest: makeManifest(),
    thumbnails: {},
    ffmpeg: null,
    busy: null,
    dirty: false,
    lastError: null,
    exportQuality: 'veryHigh',
    exportProgress: null,
    exportResult: null,
    syncBusy: false,
    syncResult: null,
    transcribing: false,
    transcript: null,
    progress: null,
    anglePlan: null,
    analyzingTakes: false,
    takesPlan: null,
    isPlaying: false,
    hasClipboard: false,
    colorInspectorOpen: false,
    audioInspectorOpen: false,
    rightTab: 'chat' as const,
    tabs: [{ id: sessions[0].id, name: sessions[0].name, dirty: false }],
    activeTabId: sessions[0].id,
    takesInputOpen: false,

    init: async () => {
      window.editorBridge.onExportProgress((fraction) =>
        set((s) => {
          s.exportProgress = fraction
        })
      )
      window.editorBridge.onOpProgress(({ line }) => {
        if (!line) return
        const p = get().progress
        if (!p || p.done) return
        get().appendProgressLog(line)
      })
      const ffmpeg = await window.editorBridge.checkFfmpeg()
      set((s) => {
        s.ffmpeg = ffmpeg
      })
    },

    newProject: () => {
      getController().reset(makeTimeline())
      set((s) => {
        s.projectDir = null
        s.projectName = 'Untitled Project'
        s.createdAt = new Date().toISOString()
        s.manifest = makeManifest()
        s.thumbnails = {}
        s.dirty = false
        s.lastError = null
      })
    },

    importFiles: async () => {
      const paths = await window.editorBridge.pickMediaFiles()
      if (paths.length === 0) return
      set((s) => {
        s.busy = `Importing ${paths.length} file${paths.length === 1 ? '' : 's'}…`
        s.lastError = null
      })
      try {
        const imported = await window.editorBridge.importMedia(paths)
        set((s) => {
          for (const { entry, thumbnail } of imported) {
            s.manifest.entries.push(entry)
            s.thumbnails[entry.id] = thumbnail
          }
          if (imported.length > 0) s.dirty = true
        })
        maybeAdoptProjectSettings(imported)
      } catch (e) {
        set((s) => {
          s.lastError = e instanceof Error ? e.message : String(e)
        })
      } finally {
        set((s) => {
          s.busy = null
        })
      }
    },

    // Import from explicit paths/URLs (used by the AI tools / MCP, e.g. a generated clip).
    importFromSources: async (sources) => {
      const imported = await window.editorBridge.importSources(sources)
      set((s) => {
        for (const { entry, thumbnail } of imported) {
          s.manifest.entries.push(entry)
          s.thumbnails[entry.id] = thumbnail
        }
        if (imported.length > 0) s.dirty = true
      })
      maybeAdoptProjectSettings(imported)
      return imported
    },

    saveProject: async () => {
      let dir = get().projectDir
      if (!dir) {
        const picked = await window.editorBridge.pickSaveProjectPath(get().projectName)
        if (!picked) return
        dir = picked
        set((s) => {
          s.projectDir = picked
          s.projectName = projectNameFromPath(picked)
        })
      }
      set((s) => {
        s.busy = 'Saving…'
      })
      const { projectName, createdAt, manifest } = get()
      const res = await window.editorBridge.saveProject(dir, {
        meta: { schemaVersion: PROJECT_SCHEMA_VERSION, name: projectName, createdAt, modifiedAt: new Date().toISOString() },
        timeline: getController().getTimeline(),
        manifest
      })
      set((s) => {
        s.busy = null
        if (res.ok) s.dirty = false
        else s.lastError = res.error ?? 'Save failed'
      })
    },

    openProject: async () => {
      const dir = await window.editorBridge.pickOpenProjectDir()
      if (!dir) return
      set((s) => {
        s.busy = 'Opening…'
        s.lastError = null
      })
      try {
        const data = await window.editorBridge.loadProject(dir)
        getController().load(data.timeline)
        set((s) => {
          s.projectDir = dir
          s.projectName = data.meta.name || projectNameFromPath(dir)
          s.createdAt = data.meta.createdAt
          s.manifest = data.manifest
          s.thumbnails = {}
          s.dirty = false
        })
        // Regenerate session thumbnails for restored assets.
        const items = data.manifest.entries
          .map((e) => {
            const path = expectedPath(data.manifest, e.id, dir)
            return path ? { id: e.id, path, type: e.type, durationSeconds: e.duration } : null
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
        if (items.length > 0) {
          const thumbs = await window.editorBridge.loadThumbnails(items)
          set((s) => {
            for (const t of thumbs) s.thumbnails[t.id] = t.thumbnail
          })
        }
      } catch (e) {
        set((s) => {
          s.lastError = e instanceof Error ? e.message : String(e)
        })
      } finally {
        set((s) => {
          s.busy = null
        })
      }
    },

    exportProject: async () => {
      const out = await window.editorBridge.pickExportPath(get().projectName)
      if (!out) return
      set((s) => {
        s.busy = 'Exportando…'
        s.lastError = null
        s.exportProgress = 0
        s.exportResult = null
      })
      const res = await window.editorBridge.exportTimeline({
        timeline: getController().getTimeline(),
        manifest: get().manifest,
        projectDir: get().projectDir,
        outputPath: out,
        quality: get().exportQuality
      })
      set((s) => {
        s.busy = null
        s.exportProgress = null
        s.exportResult = res.ok
          ? { ok: true, outputPath: res.outputPath ?? out }
          : { ok: false, error: res.error ?? 'Export failed' }
        if (!res.ok) s.lastError = res.error ?? 'Export failed'
      })
    },

    exportToPath: async (outputPath) => {
      set((s) => {
        s.busy = 'Exportando…'
        s.lastError = null
        s.exportProgress = 0
      })
      const res = await window.editorBridge.exportTimeline({
        timeline: getController().getTimeline(),
        manifest: get().manifest,
        projectDir: get().projectDir,
        outputPath,
        quality: get().exportQuality
      })
      set((s) => {
        s.busy = null
        s.exportProgress = null
        if (!res.ok) s.lastError = res.error ?? 'Export failed'
      })
      return res.ok
        ? { ok: true, result: { outputPath: res.outputPath ?? outputPath, durationSeconds: res.durationSeconds } }
        : { ok: false, error: res.error ?? 'Export failed' }
    },

    setResolution: (width, height) => getController().setResolution(width, height),
    setFps: (fps) => getController().setFps(fps),
    setExportQuality: (q) =>
      set((s) => {
        s.exportQuality = q
      }),
    dismissExportResult: () =>
      set((s) => {
        s.exportResult = null
      }),
    revealExport: (filePath) => void window.editorBridge.showItemInFolder(filePath),

    extractAudioFromClip: async (clipOrAssetId) => {
      const c = getController()
      const { manifest, projectDir } = get()
      const clip = c.getClip(clipOrAssetId)
      const assetId = clip ? clip.mediaRef : clipOrAssetId
      const entry = manifest.entries.find((e) => e.id === assetId)
      if (!entry) return { ok: false, error: 'Extraer audio: asset no encontrado.' }
      if (entry.type !== 'video') return { ok: false, error: 'Extraer audio: selecciona un clip de video.' }
      if (entry.hasAudio === false) return { ok: false, error: 'Extraer audio: este video no tiene pista de audio.' }
      const videoPath = expectedPath(manifest, assetId, projectDir)
      if (!videoPath) return { ok: false, error: 'Extraer audio: el archivo está offline.' }
      set((s) => {
        s.busy = 'Extrayendo audio…'
        s.lastError = null
      })
      const ex = await window.editorBridge.extractAudio({ videoPath, outDir: projectDir })
      if (!ex.ok || !ex.outputPath) {
        set((s) => {
          s.busy = null
          s.lastError = ex.error ?? 'Extracción de audio fallida'
        })
        return { ok: false, error: ex.error ?? 'Extracción de audio fallida' }
      }
      const imported = await get().importFromSources([ex.outputPath])
      set((s) => {
        s.busy = null
      })
      return { ok: true, result: { assetId: imported[0]?.entry.id, name: imported[0]?.entry.name } }
    },

    enhanceClipAudio: async (clipId, settings = {}) => {
      const c = getController()
      const { manifest, projectDir } = get()
      const clip = c.getClip(clipId)
      if (!clip || clip.mediaType !== 'audio') {
        alert('Realzar audio: selecciona un clip en una pista de audio.')
        return { ok: false, error: 'Realzar audio: selecciona un clip de audio.' }
      }
      const srcPath = expectedPath(manifest, clip.mediaRef, projectDir)
      if (!srcPath) {
        alert('Realzar audio: el archivo del clip está offline.')
        return { ok: false, error: 'Realzar audio: el archivo del clip está offline.' }
      }

      get().startProgress('Realzar audio (voz)', [
        { id: 'enhance', label: 'Renderizar audio mejorado (FFmpeg)' },
        { id: 'place', label: 'Reemplazar el audio del clip' }
      ])
      get().setStep('enhance', 'active')
      const r = await window.editorBridge.enhanceAudio({ srcPath, outDir: projectDir, ...settings })
      if (!r.ok || !r.outputPath) {
        get().setStep('enhance', 'error', r.error)
        get().finishProgress('No se pudo realzar el audio: ' + (r.error ?? ''))
        return { ok: false, error: r.error ?? 'Mejora de audio fallida' }
      }
      get().setStep('enhance', 'done')

      const imported = await get().importFromSources([r.outputPath])
      const audioAssetId = imported[0]?.entry.id
      if (!audioAssetId) {
        get().finishProgress('No se pudo importar el audio mejorado.')
        return { ok: false, error: 'Import del audio mejorado fallido' }
      }

      // Replace the audio clip's media IN PLACE: the enhanced render has the same duration/timebase, so
      // the clip's existing position/trim/volume/fades stay valid. One undo step.
      get().setStep('place', 'active')
      c.runAs('user', () => c.replaceClipMedia(clip.id, audioAssetId, 'Realzar audio'))
      get().setStep('place', 'done')
      get().finishProgress()
      return { ok: true, result: { audioAssetId } }
    },

    isolateClipVoice: async (clipId, intensity, denoise) => {
      const c = getController()
      const { manifest, projectDir } = get()
      const clip = c.getClip(clipId)
      if (!clip || clip.mediaType !== 'audio') {
        alert('Aislar voz: selecciona un clip en una pista de audio.')
        return { ok: false, error: 'Aislar voz: selecciona un clip de audio.' }
      }
      const srcPath = expectedPath(manifest, clip.mediaRef, projectDir)
      if (!srcPath) {
        alert('Aislar voz: el archivo del clip está offline.')
        return { ok: false, error: 'Aislar voz: el archivo del clip está offline.' }
      }

      get().startProgress('Aislar voz (IA · ElevenLabs)', [
        { id: 'isolate', label: 'Aislar voz con IA (ElevenLabs)' },
        { id: 'place', label: 'Reemplazar el audio del clip' }
      ])
      get().setStep('isolate', 'active')
      const r = await window.editorBridge.isolateVoice({ srcPath, outDir: projectDir, intensity, denoise })
      if (!r.ok || !r.outputPath) {
        get().setStep('isolate', 'error', r.error)
        get().finishProgress('No se pudo aislar la voz: ' + (r.error ?? ''))
        return { ok: false, error: r.error ?? 'Aislamiento de voz fallido' }
      }
      get().setStep('isolate', 'done')

      const imported = await get().importFromSources([r.outputPath])
      const audioAssetId = imported[0]?.entry.id
      if (!audioAssetId) {
        get().finishProgress('No se pudo importar el audio aislado.')
        return { ok: false, error: 'Import del audio aislado fallido' }
      }

      // Replace the clip's media IN PLACE: isolation preserves duration/timebase, so the clip's position/
      // trim/fades stay valid. The non-destructive `audioEnhance` DSP (if any) keeps applying on top.
      get().setStep('place', 'active')
      c.runAs('user', () => c.replaceClipMedia(clip.id, audioAssetId, 'Aislar voz (IA)'))
      get().setStep('place', 'done')
      get().finishProgress()
      return { ok: true, result: { audioAssetId } }
    },

    optimizePlayback: async () => {
      const { manifest, projectDir } = get()
      const videos = manifest.entries.filter((e) => e.type === 'video' && !e.proxyPath)
      if (videos.length === 0) {
        alert('La reproducción ya está optimizada (todos los videos tienen proxy).')
        return { ok: true }
      }
      get().startProgress(
        'Optimizar reproducción (proxies)',
        videos.map((v, i) => ({ id: `proxy${i}`, label: `Proxy: ${v.name}` }))
      )
      let done = 0
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i]
        const srcPath = expectedPath(manifest, v.id, projectDir)
        if (!srcPath) {
          get().setStep(`proxy${i}`, 'error', 'archivo offline')
          continue
        }
        get().setStep(`proxy${i}`, 'active')
        const r = await window.editorBridge.generateProxy({ srcPath, outDir: projectDir })
        if (!r.ok || !r.outputPath) {
          get().setStep(`proxy${i}`, 'error', r.error)
          continue
        }
        set((s) => {
          const e = s.manifest.entries.find((x) => x.id === v.id)
          if (e) e.proxyPath = r.outputPath
          s.dirty = true
        })
        get().setStep(`proxy${i}`, 'done')
        done++
      }
      get().finishProgress()
      return { ok: true, result: { proxiesGenerated: done } }
    },

    analyzeSyncForSelection: async () => {
      const c = getController()
      const { manifest, projectDir } = get()
      const videoClips = c
        .getSelectedClipIds()
        .map((id) => c.getClip(id))
        .filter((cl): cl is Clip => !!cl && cl.mediaType === 'video')
      if (videoClips.length !== 2) {
        set((s) => {
          s.lastError = 'Sincronizar ángulos: selecciona exactamente 2 clips de video.'
        })
        return
      }
      const [frontal, lateral] = videoClips
      const pathA = expectedPath(manifest, frontal.mediaRef, projectDir)
      const pathB = expectedPath(manifest, lateral.mediaRef, projectDir)
      if (!pathA || !pathB) {
        set((s) => {
          s.lastError = 'Sincronizar ángulos: un clip está offline.'
        })
        return
      }
      set((s) => {
        s.syncBusy = true
        s.syncResult = null
        s.lastError = null
      })
      const fps = c.getTimeline().fps

      // 1) Precise path: match the WORDS both angles spoke (validated by voice-intensity peaks). Word
      //    timestamps are exact landmarks, so this aligns the lateral to the frontal far better than RMS.
      let offsetSeconds: number | undefined
      let confidence = 0
      let reliable = false
      let method: 'transcript' | 'audio' = 'audio'
      try {
        const [wa, wb] = await Promise.all([
          transcribeCached(pathA, frontal.mediaRef),
          transcribeCached(pathB, lateral.mediaRef)
        ])
        if (wa && wb) {
          const [ia, ib] = await Promise.all([
            window.editorBridge.analyzeIntensity(pathA),
            window.editorBridge.analyzeIntensity(pathB)
          ])
          const al = alignByTranscript(wa, wb, {
            peaksFrontalSec: ia.ok ? ia.peaks : undefined,
            peaksLateralSec: ib.ok ? ib.peaks : undefined
          })
          if (al.confidence >= 0.2 && al.matched >= 5) {
            offsetSeconds = al.offsetSeconds
            confidence = al.confidence
            reliable = al.confidence >= 0.35
            method = 'transcript'
          }
        }
      } catch {
        /* fall back to cross-correlation below */
      }

      // 2) Fallback: RMS envelope cross-correlation (the original method).
      if (offsetSeconds === undefined) {
        const r = await window.editorBridge.computeAudioOffset({ pathA, pathB, fps })
        if (!r.ok || r.offsetSeconds === undefined) {
          set((s) => {
            s.syncBusy = false
            s.syncResult = { ok: false, error: r.error ?? 'Análisis de audio fallido' }
          })
          return
        }
        offsetSeconds = r.offsetSeconds
        confidence = r.confidence ?? 0
        reliable = r.reliable ?? false
        method = 'audio'
      }

      set((s) => {
        s.syncBusy = false
        s.syncResult = {
          ok: true,
          offsetSeconds,
          offsetFrames: Math.round((offsetSeconds as number) * fps),
          confidence,
          reliable,
          method,
          frontalClipId: frontal.id,
          lateralClipId: lateral.id
        }
      })
    },

    applySyncAngles: async (opts, origin = 'user') => {
      const c = getController()
      const { manifest, projectDir } = get()
      const frontal = c.getClip(opts.frontalClipId)
      const lateral = c.getClip(opts.lateralClipId)
      if (!frontal || !lateral) return { ok: false, error: 'Sincronizar: clip no encontrado.' }
      const fps = c.getTimeline().fps
      const keep = opts.keepAudioOf === 'lateral' ? lateral : frontal
      const keepPath = expectedPath(manifest, keep.mediaRef, projectDir)
      if (!keepPath) return { ok: false, error: 'Sincronizar: el clip de audio está offline.' }

      // Extract the kept angle's audio to its own asset (the continuous, switch-proof audio track).
      set((s) => {
        s.busy = 'Preparando audio sincronizado…'
        s.lastError = null
      })
      const ex = await window.editorBridge.extractAudio({ videoPath: keepPath, outDir: projectDir })
      if (!ex.ok || !ex.outputPath) {
        set((s) => {
          s.busy = null
          s.lastError = ex.error ?? 'Extracción de audio fallida'
        })
        return { ok: false, error: ex.error ?? 'Extracción de audio fallida' }
      }
      const imported = await get().importFromSources([ex.outputPath])
      const audioAssetId = imported[0]?.entry.id
      set((s) => {
        s.busy = null
      })

      const offsetFrames = Math.round(opts.offsetSeconds * fps)
      let frontalTrim = 0
      let lateralTrim = 0
      if (offsetFrames > 0) {
        frontalTrim = offsetFrames
      } else {
        lateralTrim = -offsetFrames
      }

      const finalDuration = Math.min(frontal.durationFrames - frontalTrim, lateral.durationFrames - lateralTrim)
      const keptTrim = opts.keepAudioOf === 'lateral' ? lateralTrim : frontalTrim

      const linkGroupId = newId()
      // Tracks the clips currently live on — they'll be left empty after the move, so we remove them.
      const frontalSrcTrackId = c.getTrackOfClip(opts.frontalClipId)?.id ?? null
      const lateralSrcTrackId = c.getTrackOfClip(opts.lateralClipId)?.id ?? null

      c.runAs(origin, () =>
        c.transact('Sincronizar ángulos', () => {
          const lateralTrackId = c.addTrack('video', 0)
          const frontalTrackId = c.addTrack('video', 0) // frontal ends up on top
          // Clear any pre-existing role tags on other video tracks so exactly ONE frontal + ONE lateral
          // exist after sync (avoids stale/duplicate tags on the tracks we're about to empty/remove).
          for (const t of c.getTimeline().tracks) {
            if (t.type === 'video' && t.id !== frontalTrackId && t.id !== lateralTrackId && t.role) {
              c.setTrackRole(t.id, undefined)
            }
          }
          // Tag roles so the auto-angle engine knows which track is which without guessing.
          c.setTrackRole(frontalTrackId, 'frontal')
          c.setTrackRole(lateralTrackId, 'lateral')
          c.moveClips([
            { clipId: opts.frontalClipId, toTrackId: frontalTrackId, toFrame: 0 },
            { clipId: opts.lateralClipId, toTrackId: lateralTrackId, toFrame: 0 }
          ])
          c.setClipSourceWindow(opts.frontalClipId, frontal.trimStartFrame + frontalTrim, finalDuration)
          c.setClipSourceWindow(opts.lateralClipId, lateral.trimStartFrame + lateralTrim, finalDuration)
          c.setClipProperties(opts.frontalClipId, { volume: 0 }, 'Silenciar ángulo')
          c.setClipProperties(opts.lateralClipId, { volume: 0 }, 'Silenciar ángulo')
          if (audioAssetId) {
            const audioTrackId = c.addTrack('audio')
            c.addClip({
              trackId: audioTrackId,
              mediaRef: audioAssetId,
              mediaType: 'audio',
              startFrame: 0,
              durationFrames: finalDuration,
              trimStartFrame: keep.trimStartFrame + keptTrim,
              speed: keep.speed
            })
          }
          c.setClipProperties(opts.frontalClipId, { linkGroupId }, 'Agrupar ángulos')
          c.setClipProperties(opts.lateralClipId, { linkGroupId }, 'Agrupar ángulos')
          if (opts.autoColor) {
            const fp = presetById.get('guillermo-frontal-v1')
            const lp = presetById.get('guillermo-lateral-v1')
            if (fp) c.setClipColor(opts.frontalClipId, fp.color)
            if (lp) c.setClipColor(opts.lateralClipId, lp.color)
          }
          // Remove the original tracks the clips were moved off of, if now empty (don't leave phantoms).
          for (const tid of new Set([frontalSrcTrackId, lateralSrcTrackId])) {
            if (!tid || tid === frontalTrackId || tid === lateralTrackId) continue
            const t = c.getTrack(tid)
            if (t && t.clips.length === 0) c.removeTrack(tid)
          }
        })
      )
      alert('¡Sincronización completada!')
      return {
        ok: true,
        result: { offsetSeconds: opts.offsetSeconds, offsetFrames, fps, linkGroupId, audioAssetId }
      }
    },

    syncAnglesTool: async (input) => {
      const c = getController()
      const { manifest, projectDir } = get()
      const ids = input.clipIds ?? c.getSelectedClipIds()
      const clips = ids
        .map((id) => c.getClip(id))
        .filter((cl): cl is Clip => !!cl && cl.mediaType === 'video')
      if (clips.length !== 2) return { ok: false, error: 'sync_angles: se necesitan exactamente 2 clips de video.' }
      const [frontal, lateral] = clips
      const pathA = expectedPath(manifest, frontal.mediaRef, projectDir)
      const pathB = expectedPath(manifest, lateral.mediaRef, projectDir)
      if (!pathA || !pathB) return { ok: false, error: 'sync_angles: un clip está offline.' }
      const r = await window.editorBridge.computeAudioOffset({ pathA, pathB, fps: c.getTimeline().fps })
      if (!r.ok || r.offsetSeconds === undefined) return { ok: false, error: r.error ?? 'sync_angles: análisis fallido.' }
      const applied = await get().applySyncAngles(
        {
          frontalClipId: frontal.id,
          lateralClipId: lateral.id,
          offsetSeconds: r.offsetSeconds,
          keepAudioOf: input.keepAudioOf === 'second' ? 'lateral' : 'frontal',
          autoColor: input.autoColor ?? true
        },
        'agent'
      )
      if (!applied.ok) return applied
      const fps = c.getTimeline().fps
      return {
        ok: true,
        result: {
          offsetSeconds: r.offsetSeconds,
          offsetFrames: Math.round(r.offsetSeconds * fps),
          fps,
          confidence: r.confidence,
          lowConfidence: !r.reliable
        }
      }
    },

    dismissSyncResult: () =>
      set((s) => {
        s.syncResult = null
      }),

    transcribeClip: async (clipOrAssetId, opts) => {
      // Resolve the media path from either a clip id or an asset id.
      const tl = getController().getTimeline()
      const manifest = get().manifest
      let mediaPath: string | null = null

      // Try as asset id first, then as clip id.
      const entry = manifest.entries.find((e) => e.id === clipOrAssetId)
      if (entry) {
        mediaPath = expectedPath(manifest, clipOrAssetId, get().projectDir)
      } else {
        for (const track of tl.tracks) {
          const clip = track.clips.find((c) => c.id === clipOrAssetId)
          if (clip) {
            mediaPath = expectedPath(manifest, clip.mediaRef, get().projectDir)
            break
          }
        }
      }
      if (!mediaPath) return { ok: false, error: `transcribe: clip/asset "${clipOrAssetId}" not found.` }

      set((s) => { s.transcribing = true; s.lastError = null })
      try {
        const res = await window.editorBridge.transcribeMedia({ mediaPath, ...opts })
        if (!res.ok || !res.words) {
          set((s) => { s.transcribing = false; s.lastError = res.error ?? 'Transcription failed.' })
          return { ok: false, error: res.error }
        }
        set((s) => { s.transcribing = false; s.transcript = res.words! })
        return { ok: true, result: { wordCount: res.words!.length, text: res.text } }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        set((s) => { s.transcribing = false; s.lastError = msg })
        return { ok: false, error: msg }
      }
    },

clearTranscript: () => set((s) => { s.transcript = null }),

    exportTranscriptSrt: async () => {
      const words = get().transcript
      if (!words) return
      // Group consecutive words into ~5-word subtitle lines, emit SRT.
      const onlyWords = words.filter((w) => w.type === 'word')
      if (!onlyWords.length) return
      const lines: { start: number; end: number; text: string }[] = []
      const GROUP = 5
      for (let i = 0; i < onlyWords.length; i += GROUP) {
        const chunk = onlyWords.slice(i, i + GROUP)
        lines.push({ start: chunk[0].startMs, end: chunk[chunk.length - 1].endMs, text: chunk.map((w) => w.text).join(' ') })
      }
      const toSrtTime = (ms: number): string => {
        const h = Math.floor(ms / 3600000)
        const m = Math.floor((ms % 3600000) / 60000)
        const s = Math.floor((ms % 60000) / 1000)
        const msRem = ms % 1000
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(msRem).padStart(3, '0')}`
      }
      const srt = lines
        .map((l, i) => `${i + 1}\n${toSrtTime(l.start)} --> ${toSrtTime(l.end)}\n${l.text}`)
        .join('\n\n')
      // Write to a blob and trigger download via a data URL.
      const blob = new Blob([srt], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${get().projectName}.srt`
      a.click()
      URL.revokeObjectURL(url)
    },

    startProgress: (title, steps) =>
      set((s) => {
        s.progress = { title, steps: steps.map((st) => ({ ...st, status: 'pending' as const })), log: [], done: false }
      }),

    setStep: (id, status, detail) =>
      set((s) => {
        const st = s.progress?.steps.find((x) => x.id === id)
        if (st) {
          st.status = status
          if (detail !== undefined) st.detail = detail
        }
      }),

    appendProgressLog: (line) =>
      set((s) => {
        if (!s.progress) return
        s.progress.log.push(line)
        if (s.progress.log.length > 500) s.progress.log.splice(0, s.progress.log.length - 500)
      }),

    finishProgress: (error) =>
      set((s) => {
        if (!s.progress) return
        s.progress.done = true
        if (error) {
          s.progress.error = error
          const active = s.progress.steps.find((x) => x.status === 'active')
          if (active) active.status = 'error'
        } else {
          for (const st of s.progress.steps) if (st.status !== 'error') st.status = 'done'
        }
      }),

    dismissProgress: () =>
      set((s) => {
        s.progress = null
      }),

    analyzeAutoAngles: async (opts) => {
      const r = await buildAnglePlan(get, opts?.destructive ?? true)
      if (r.ok && r.plan) set((s) => { s.anglePlan = r.plan! })
      else if (r.ok && !r.plan)
        alert(
          'No se detectaron pausas ni picos de volumen para cortar en el audio del ángulo frontal. Probá con un clip con más variación de volumen, o sincronizá los ángulos primero.'
        )
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },

    applyAnglePlan: () => {
      const plan = get().anglePlan
      if (!plan) return
      const { applied, skipped } = applyPlanCuts(getController(), plan)
      set((s) => { s.anglePlan = null })
      if (applied === 0) {
        alert(
          'No se aplicó ningún corte: las pistas de los ángulos no están alineadas en la línea de tiempo. Sincronizá los ángulos primero (botón "Sincronizar") para que empiecen alineados.'
        )
      } else if (skipped > 0) {
        set((s) => { s.lastError = `Cambios de ángulo aplicados: ${applied} cortes (${skipped} omitidos por falta de alineación).` })
      }
    },

    setAnglePlanDestructive: (destructive) =>
      set((s) => {
        if (s.anglePlan) s.anglePlan.destructive = destructive
      }),

    setAnglePlanRole: (trackId, role) =>
      set((s) => {
        const plan = s.anglePlan
        if (!plan) return
        const target = plan.angleTracks.find((a) => a.trackId === trackId)
        if (!target || target.role === role) return
        // Keep roles distinct: whoever currently holds `role` takes the target's old role.
        const other = plan.angleTracks.find((a) => a.role === role)
        if (other) other.role = target.role
        target.role = role
        plan.angleTracks.sort((a, b) => (a.role === 'frontal' ? -1 : b.role === 'frontal' ? 1 : 0))
      }),

    dismissAnglePlan: () => set((s) => { s.anglePlan = null }),

    analyzeTakes: async (clipOrAssetId, scripts, cleanCuts = false) => {
      const c = getController()
      const tl = c.getTimeline()
      const isAudible = (cl: Clip): boolean => cl.mediaType === 'video' || cl.mediaType === 'audio'
      // Resolve the raw clip: explicit id → a selected audible clip → the first audible clip.
      let clip: Clip | null = null
      if (clipOrAssetId) {
        for (const t of tl.tracks) {
          const cl = t.clips.find((x) => x.id === clipOrAssetId)
          if (cl) { clip = cl; break }
        }
      }
      if (!clip) {
        const sel = c.getSelectedClipIds()
        for (const t of tl.tracks) for (const cl of t.clips) if (sel.includes(cl.id) && isAudible(cl)) clip = cl
      }
      if (!clip) {
        // Auto-pick: prefer the (optimized) audio track — best transcription + its source time maps
        // cleanly to the timeline — then fall back to the first video clip.
        const audible: Clip[] = []
        for (const t of tl.tracks) for (const cl of t.clips) if (isAudible(cl)) audible.push(cl)
        clip = audible.find((cl) => cl.mediaType === 'audio') ?? audible[0] ?? null
      }
      if (!clip) return { ok: false, error: 'No hay un clip de video para analizar. Importá un crudo y agregalo a la línea de tiempo.' }
      const raw = clip
      const mediaPath = expectedPath(get().manifest, raw.mediaRef, get().projectDir)
      if (!mediaPath) {
        alert('El archivo del clip no se encuentra en el disco.')
        return { ok: false, error: 'El medio del clip está offline.' }
      }

      set((s) => { s.analyzingTakes = true; s.lastError = null })
      get().startProgress('Detectar tomas', [
        { id: 'transcribe', label: 'Transcribir audio (ElevenLabs Scribe)' },
        { id: 'analyze', label: 'Detectar guiones y cortes (Claude)' }
      ])
      try {
        get().setStep('transcribe', 'active')
        let words = transcriptCache.get(raw.mediaRef) ?? null
        if (!words) {
          const r = await window.editorBridge.transcribeMedia({ mediaPath, languageCode: 'es' })
          if (!r.ok || !r.words) {
            get().finishProgress(r.error ?? 'La transcripción falló.')
            set((s) => { s.analyzingTakes = false })
            return { ok: false, error: r.error }
          }
          // Never cache a transcript without usable times — a poisoned cache survives re-runs.
          const invalid = r.words.some((w) => !Number.isFinite(w.startMs) || !Number.isFinite(w.endMs))
          if (invalid) {
            const msg = 'La transcripción llegó sin timestamps válidos. Volvé a intentar.'
            get().finishProgress(msg)
            set((s) => { s.analyzingTakes = false })
            return { ok: false, error: msg }
          }
          words = r.words
          transcriptCache.set(raw.mediaRef, words)
        }
        set((s) => { s.transcript = words })
        get().setStep('transcribe', 'done')

        get().setStep('analyze', 'active')
        const res = await window.editorBridge.analyzeTakes({ words, languageCode: 'es', scripts, cleanCuts })
        if (!res.ok || !res.plan) {
          get().finishProgress(res.error ?? 'El análisis falló.')
          set((s) => { s.analyzingTakes = false })
          return { ok: false, error: res.error }
        }
        const plan = res.plan
        set((s) => {
          s.analyzingTakes = false
          s.takesPlan = {
            takes: plan.takes,
            cuts: plan.cuts,
            durationMs: plan.durationMs,
            rawClipId: raw.id,
            rawMediaRef: raw.mediaRef,
            fps: tl.fps,
            // Default-off any take whose guión was poorly matched (<50%), so a low-coverage/misaligned
            // take isn't opened by accident; well-matched (or inference-mode) takes stay on.
            takeAccepted: plan.takes.map((t) => (t.coverage ? t.coverage.fraction >= 0.5 : true)),
            cutAccepted: plan.cuts.map(() => true),
            scriptBlocks: scripts ? splitScriptBlocks(scripts) : []
          }
        })
        get().finishProgress()
        get().dismissProgress()
        return { ok: true, result: { takes: plan.takes.length, cuts: plan.cuts.length } }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        get().finishProgress(msg)
        set((s) => { s.analyzingTakes = false })
        return { ok: false, error: msg }
      }
    },

    setTakeAccepted: (i, accepted) =>
      set((s) => {
        if (s.takesPlan && i >= 0 && i < s.takesPlan.takeAccepted.length) s.takesPlan.takeAccepted[i] = accepted
      }),

    setCutAccepted: (i, accepted) =>
      set((s) => {
        if (s.takesPlan && i >= 0 && i < s.takesPlan.cutAccepted.length) s.takesPlan.cutAccepted[i] = accepted
      }),

    dismissTakesPlan: () => set((s) => { s.takesPlan = null }),

    applyTakesPlan: async () => {
      const plan = get().takesPlan
      if (!plan) return
      const c = getController()
      const tl = c.getTimeline()
      // Resolve the raw clip again (by id, then by mediaRef in case it was split/moved).
      let rawClip: Clip | null = null
      for (const t of tl.tracks) {
        const cl = t.clips.find((x) => x.id === plan.rawClipId)
        if (cl) { rawClip = cl; break }
      }
      if (!rawClip) {
        for (const t of tl.tracks) {
          const cl = t.clips.find((x) => x.mediaRef === plan.rawMediaRef)
          if (cl) { rawClip = cl; break }
        }
      }
      if (!rawClip) {
        set((s) => { s.lastError = 'El clip crudo ya no está en la línea de tiempo.'; s.takesPlan = null })
        return
      }
      const raw = rawClip
      const accepted = plan.takes.filter((_, i) => plan.takeAccepted[i])
      if (accepted.length === 0) {
        alert('Seleccioná al menos una toma.')
        return
      }

      // Open each accepted take as its own editable tab (a cleaned segment). Export happens later,
      // manually, from each tab's normal "Exportar" button.
      const manifest = get().manifest
      const projectDir = get().projectDir // inherit so proxies/enhanced audio/export resolve in take tabs
      saveActiveToSession() // persist the current (raw) tab before opening the take tabs
      let firstId = ''
      const failed: string[] = []
      for (const take of accepted) {
        // "Ya limpia": apply ALL cuts detected inside this take (the cut list is not user-selectable).
        const cutsForTake = plan.cuts.filter((cut) => cut.takeIndex === take.index)
        const takeTimeline = buildTakeTimeline(tl, raw, take, cutsForTake)
        if (!takeTimeline) {
          failed.push(`Guión ${take.index}: ${take.title}`)
          continue
        }
        const id = openSession(`Guión ${take.index}`, takeTimeline, manifest, projectDir)
        if (!firstId) firstId = id
      }
      if (failed.length > 0) {
        const msg =
          `No se pudo ubicar ${failed.length === 1 ? 'esta toma' : 'estas tomas'} en la línea de tiempo ` +
          `(tiempos fuera del clip transcrito):\n${failed.join('\n')}\n\nProbá volver a transcribir/segmentar.`
        set((s) => { s.lastError = msg })
        alert(msg)
      }
      set((s) => { s.takesPlan = null; s.takesInputOpen = false })
      const target = sessions.find((s) => s.id === firstId)
      if (target) loadSessionIntoStore(target)
    },

    setPlaying: (playing) => set((s) => { s.isPlaying = playing }),

    togglePlayback: () => {
      const c = getController()
      const total = c.totalFrames()
      if (total === 0) return
      const playing = get().isPlaying
      if (!playing && c.getCurrentFrame() >= total) c.seek(0)
      set((s) => { s.isPlaying = !playing })
    },

    copySelection: () => {
      const c = getController()
      const payload = serializeSelection(c.getTimeline(), c.getSelectedClipIds())
      if (!payload) return
      clipboard = payload
      set((s) => { s.hasClipboard = true })
    },

    cutSelection: () => {
      const c = getController()
      const ids = c.getSelectedClipIds()
      const payload = serializeSelection(c.getTimeline(), ids)
      if (!payload) return
      clipboard = payload
      c.transact('Cortar', () => c.removeClips(ids))
      set((s) => { s.hasClipboard = true })
    },

    pasteAtFrame: (frame) => {
      const c = getController()
      if (!clipboard) return
      const at = frame ?? c.getCurrentFrame()
      const targets = resolvePasteTargets(c.getTimeline(), clipboard, at)
      const newIds: string[] = []
      c.transact('Pegar', () => {
        newIds.push(...c.insertClips(targets.existing, 'Pegar'))
        for (const nt of targets.needTracks) {
          const trackId = c.addTrack(nt.trackType)
          newIds.push(...c.insertClips(nt.items.map((it) => ({ ...it, trackId })), 'Pegar'))
        }
      })
      if (newIds.length > 0) c.select(newIds)
    },

    duplicateSelection: () => {
      const c = getController()
      const ids = c.getSelectedClipIds()
      if (ids.length === 0) return
      const newIds = c.duplicateClips(ids)
      if (newIds.length > 0) c.select(newIds)
    },

    setColorInspectorOpen: (open) => set((s) => { s.colorInspectorOpen = open }),
    setAudioInspectorOpen: (open) => set((s) => { s.audioInspectorOpen = open }),
    setRightTab: (tab) => set((s) => { s.rightTab = tab }),

    switchSession: (id) => {
      if (id === activeId) return
      const target = sessions.find((s) => s.id === id)
      if (!target) return
      saveActiveToSession()
      loadSessionIntoStore(target)
    },

    closeSession: (id) => {
      const idx = sessions.findIndex((s) => s.id === id)
      if (idx < 0) return
      const wasActive = id === activeId
      sessions.splice(idx, 1)
      set((s) => { s.tabs = s.tabs.filter((t) => t.id !== id) })
      if (sessions.length === 0) {
        const blank = makeSession()
        subscribeSession(blank)
        sessions.push(blank)
        set((s) => { s.tabs.push({ id: blank.id, name: blank.name, dirty: false }) })
        loadSessionIntoStore(blank)
      } else if (wasActive) {
        // The removed session was active and is discarded (no save); switch to a neighbor.
        loadSessionIntoStore(sessions[Math.min(idx, sessions.length - 1)])
      }
    },

    setTakesInputOpen: (open) => set((s) => { s.takesInputOpen = open }),

    applyAutoAngles: async (opts) => {
      // One-shot path (AI/MCP): analyze then apply immediately, no preview.
      const r = await buildAnglePlan(get, opts?.destructive ?? true)
      if (!r.ok) return { ok: false, error: r.error }
      if (r.plan) {
        applyPlanCuts(getController(), r.plan)
        return { ok: true, result: { cuts: r.plan.segments.length - 1, destructive: r.plan.destructive } }
      }
      return { ok: true }
    }
  }))
)

// Push the ACTIVE session's controller snapshot into the store so React re-renders. `edit` marks
// dirty (autosave + the tab dot); `view` (playhead/selection) and `load` (open/new) do not.
function pushSnapshotToStore(kind: EditorChangeKind): void {
  const snap = activeSession().controller.snapshot()
  useEditorStore.setState((s) => {
    s.timeline = snap.timeline
    s.currentFrame = snap.currentFrame
    s.selectedClipIds = snap.selectedClipIds
    s.canUndo = snap.canUndo
    s.canRedo = snap.canRedo
    s.undoLabel = snap.undoLabel
    s.redoLabel = snap.redoLabel
    if (kind === 'edit') {
      s.dirty = true
      const tab = s.tabs.find((t) => t.id === activeId)
      if (tab) tab.dirty = true
    }
  })
}

/** Subscribe a session's controller: mark its own `dirty` on edits, and — only while it is the
 *  active session — mirror its snapshot into the store. */
function subscribeSession(sess: Session): void {
  sess.controller.subscribe((kind) => {
    if (kind === 'edit') sess.dirty = true
    if (sess.id === activeId) pushSnapshotToStore(kind)
  })
}

/** Copy the reactive store's per-project fields back into the (outgoing) active session. */
function saveActiveToSession(): void {
  const sess = activeSession()
  const s = useEditorStore.getState()
  sess.projectDir = s.projectDir
  sess.projectName = s.projectName
  sess.createdAt = s.createdAt
  sess.manifest = s.manifest
  sess.thumbnails = s.thumbnails
  sess.transcript = s.transcript
  sess.exportQuality = s.exportQuality
  sess.dirty = s.dirty
}

/** Make `sess` active and mirror it (and its controller) into the store. Does NOT save the previous
 *  session — a switch must call `saveActiveToSession()` first; a close must not (it's discarded). */
function loadSessionIntoStore(sess: Session): void {
  activeId = sess.id
  const snap = sess.controller.snapshot()
  useEditorStore.setState((s) => {
    s.projectDir = sess.projectDir
    s.projectName = sess.projectName
    s.createdAt = sess.createdAt
    s.manifest = sess.manifest
    s.thumbnails = sess.thumbnails
    s.transcript = sess.transcript
    s.exportQuality = sess.exportQuality
    s.dirty = sess.dirty
    s.timeline = snap.timeline
    s.currentFrame = snap.currentFrame
    s.selectedClipIds = snap.selectedClipIds
    s.canUndo = snap.canUndo
    s.canRedo = snap.canRedo
    s.undoLabel = snap.undoLabel
    s.redoLabel = snap.redoLabel
    s.activeTabId = sess.id
    // Transient per-project UI shouldn't leak across tabs.
    s.anglePlan = null
    s.takesPlan = null
    s.syncResult = null
  })
}

// Subscribe the initial session created at module load.
subscribeSession(sessions[0])

export function timelineTotalFrames(timeline: Timeline): number {
  return totalFrames(timeline)
}
