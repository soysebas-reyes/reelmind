// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer-side live editing state. The EditorController (in @core) is the single source of
// truth for the timeline + undo/redo; this store mirrors its snapshot for React rendering and
// owns the things the controller doesn't: project IO, the media bin, and FFmpeg status.
//
// Editing commands are issued through `getController()` (UI, and later the in-app agent + MCP
// server, all call the same commands). The subscription below pushes every change back here.

import {
  type Clip,
  type CommandOrigin,
  Defaults,
  EditorController,
  type EditorChangeKind,
  type MediaManifest,
  type MediaManifestEntry,
  type Timeline,
  type ToolCallResult,
  expectedPath,
  makeManifest,
  makeTimeline,
  newId,
  presetById,
  totalFrames
} from '@core'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { PROJECT_SCHEMA_VERSION, type ExportQuality, type FfmpegStatus, type ImportedAsset } from '../../shared/ipc'

const controller = new EditorController()

/** The shared editing brain. UI components call commands on this directly. */
export function getController(): EditorController {
  return controller
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
  if (controller.getTimeline().settingsConfigured) return
  const v = imported.find(
    (a) => a.entry.type === 'video' && (a.entry.sourceWidth ?? 0) > 0 && (a.entry.sourceHeight ?? 0) > 0
  )
  if (!v) return
  const srcFps = v.entry.sourceFPS && v.entry.sourceFPS > 0 ? Math.round(v.entry.sourceFPS) : controller.getTimeline().fps
  // x264 + yuv420p require even dimensions; round down so an odd-sized source can't break the export.
  const even = (n: number): number => (n % 2 === 0 ? n : n - 1)
  controller.setProjectSettings(even(v.entry.sourceWidth as number), even(v.entry.sourceHeight as number), srcFps)
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

/** Result of the audio-offset analysis (drives the sync confirmation modal). */
export interface SyncResultState {
  ok: boolean
  offsetSeconds?: number
  offsetFrames?: number
  confidence?: number
  reliable?: boolean
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

  init: () => Promise<void>
  newProject: () => void
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
  /** Analyze the two selected video clips' audio offset → opens the sync confirmation modal. */
  analyzeSyncForSelection: () => Promise<void>
  /** Apply a multicam sync: align both angles on two video tracks, single shared audio track, optional per-angle color. */
  applySyncAngles: (opts: ApplySyncOptions, origin?: CommandOrigin) => Promise<ToolCallResult>
  /** AI/MCP entry: compute the offset then apply, in one go. */
  syncAnglesTool: (input: SyncAnglesInput) => Promise<ToolCallResult>
  dismissSyncResult: () => void
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    timeline: controller.getTimeline(),
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

    init: async () => {
      window.editorBridge.onExportProgress((fraction) =>
        set((s) => {
          s.exportProgress = fraction
        })
      )
      const ffmpeg = await window.editorBridge.checkFfmpeg()
      set((s) => {
        s.ffmpeg = ffmpeg
      })
    },

    newProject: () => {
      controller.reset(makeTimeline())
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
        timeline: controller.getTimeline(),
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
        controller.load(data.timeline)
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
        timeline: controller.getTimeline(),
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
        timeline: controller.getTimeline(),
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

    setResolution: (width, height) => controller.setResolution(width, height),
    setFps: (fps) => controller.setFps(fps),
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
      const c = controller
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

    analyzeSyncForSelection: async () => {
      const c = controller
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
      const r = await window.editorBridge.computeAudioOffset({ pathA, pathB, fps: c.getTimeline().fps })
      set((s) => {
        s.syncBusy = false
        s.syncResult = r.ok
          ? {
              ok: true,
              offsetSeconds: r.offsetSeconds,
              offsetFrames: r.offsetFrames,
              confidence: r.confidence,
              reliable: r.reliable,
              frontalClipId: frontal.id,
              lateralClipId: lateral.id
            }
          : { ok: false, error: r.error ?? 'Análisis de audio fallido' }
      })
    },

    applySyncAngles: async (opts, origin = 'user') => {
      const c = controller
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
      let frontalStart = 0
      let lateralStart = offsetFrames
      const minStart = Math.min(frontalStart, lateralStart)
      if (minStart < 0) {
        frontalStart -= minStart
        lateralStart -= minStart
      }
      const keptStart = opts.keepAudioOf === 'lateral' ? lateralStart : frontalStart
      const linkGroupId = newId()

      c.runAs(origin, () =>
        c.transact('Sincronizar ángulos', () => {
          const lateralTrackId = c.addTrack('video', 0)
          const frontalTrackId = c.addTrack('video', 0) // frontal ends up on top
          c.moveClips([
            { clipId: opts.frontalClipId, toTrackId: frontalTrackId, toFrame: frontalStart },
            { clipId: opts.lateralClipId, toTrackId: lateralTrackId, toFrame: lateralStart }
          ])
          c.setClipProperties(opts.frontalClipId, { volume: 0 }, 'Silenciar ángulo')
          c.setClipProperties(opts.lateralClipId, { volume: 0 }, 'Silenciar ángulo')
          if (audioAssetId) {
            const audioTrackId = c.addTrack('audio')
            c.addClip({
              trackId: audioTrackId,
              mediaRef: audioAssetId,
              mediaType: 'audio',
              startFrame: keptStart,
              durationFrames: keep.durationFrames,
              trimStartFrame: keep.trimStartFrame,
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
        })
      )
      return { ok: true, result: { offsetSeconds: opts.offsetSeconds, linkGroupId, audioAssetId } }
    },

    syncAnglesTool: async (input) => {
      const c = controller
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
      return {
        ok: true,
        result: { offsetSeconds: r.offsetSeconds, confidence: r.confidence, lowConfidence: !r.reliable }
      }
    },

    dismissSyncResult: () =>
      set((s) => {
        s.syncResult = null
      })
  }))
)

// Push every controller change into the store so React re-renders. `edit` marks the project
// dirty (for autosave); `view` (playhead/selection) and `load` (open/new) do not.
function syncFromController(kind: EditorChangeKind): void {
  const snap = controller.snapshot()
  useEditorStore.setState((s) => {
    s.timeline = snap.timeline
    s.currentFrame = snap.currentFrame
    s.selectedClipIds = snap.selectedClipIds
    s.canUndo = snap.canUndo
    s.canRedo = snap.canRedo
    s.undoLabel = snap.undoLabel
    s.redoLabel = snap.redoLabel
    if (kind === 'edit') s.dirty = true
  })
}
controller.subscribe(syncFromController)

export function timelineTotalFrames(timeline: Timeline): number {
  return totalFrames(timeline)
}
