// SPDX-License-Identifier: GPL-3.0-or-later
// Plans the "baked media" for an NLE handoff. The handoff hands the editor an EDITABLE project (see
// fcp7xml.ts) whose clips point at media with OUR color grade + audio enhancement already applied,
// so they open the sequence with our look in the pixels/audio and finish (subtitles/effects) there.
//
// To keep clips separate + re-editable we do NOT flatten the timeline. Instead we render at most ONE
// file per DISTINCT (source × grade × audio × flip) — the same "grade each source once" insight the
// export graph uses (exportGraph.ts): the real workflow is one color preset per angle/source, so this
// collapses to one baked file per source. Speed ≠ 1 or per-clip flip divergence falls back to a
// per-clip baked segment. A source that needs no grade AND no enhance is referenced as-is (no bake).
//
// Pure: no disk access. The main-process orchestrator (main/interchange/handoff.ts) resolves paths,
// spawns ffmpeg from buildBakeCommand(), probes the results, and feeds them to buildFcp7Xml().

import { audioEnhanceIsIdentity, type AudioEnhanceSettings } from '../model/audioEnhance'
import { type ColorAdjustments, colorIsIdentity } from '../model/color'
import { isVisual } from '../model/clipType'
import type { ClipType } from '../model/clipType'
import { trackIsActive } from '../model/keyframe'
import type { MediaManifest } from '../model/manifest'
import { entryFor } from '../model/resolver'
import { type Clip, type Timeline, colorAt, sourceFramesConsumed } from '../model/timeline'
import { sround } from '../constants'

/** How a clip's media is prepared for the handoff.
 *  - `source`: one file per source (speed 1); every clip of that source re-trims within it.
 *  - `clip`:   one file per clip (speed baked in, so the NLE never needs a time-remap).
 *  - `image`:  a still (graded once, or the original) shown for each clip's duration. */
export type BakeMode = 'source' | 'clip' | 'image'

export interface BakeJob {
  /** Dedup identity — clips with the same key share one baked (or referenced) file. */
  bakeKey: string
  mediaRef: string
  mediaType: ClipType
  mode: BakeMode
  /** Clip ids that resolve to this file (in timeline order). */
  clipIds: string[]
  /** The grade to bake, or undefined when the source is used ungraded. */
  color?: ColorAdjustments
  /** The enhancement to bake, or undefined when the audio is used raw. */
  audioEnhance?: AudioEnhanceSettings
  flipH: boolean
  flipV: boolean
  /** Playback speed baked into the file (1 for `source`/`image`). */
  speed: number
  /** Source frame at baked frame 0 (0 when referencing the whole original). */
  inFrame: number
  /** Source frame (exclusive) at the baked end. */
  outFrame: number
  /** Whether the file carries an audio stream we should map. */
  hasAudio: boolean
  /** false → reference the original media unchanged (nothing to bake). */
  needsBake: boolean
}

export interface PlanBakesOptions {
  /** Bake the whole source instead of just the used range (bigger files, wider re-trim). */
  fullLength?: boolean
}

/** Canonical stringify (sorted keys) so equal grades/settings hash identically regardless of key order. */
function canon(obj: object | undefined): string {
  if (!obj) return 'raw'
  const rec = obj as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return JSON.stringify(keys.map((k) => [k, rec[k]]))
}

function isInvisible(c: Clip): boolean {
  return c.opacity <= 0 && !trackIsActive(c.opacityTrack)
}

function clipHasAudio(clip: Clip, manifest: MediaManifest): boolean {
  if (clip.mediaType !== 'video' && clip.mediaType !== 'audio') return false
  return entryFor(manifest, clip.mediaRef)?.hasAudio ?? true
}

/** Grade applied to a visual clip, or null when identity / non-visual. */
function gradeForClip(clip: Clip): ColorAdjustments | null {
  if (!isVisual(clip.mediaType)) return null
  const col = colorAt(clip, clip.startFrame)
  return colorIsIdentity(col) ? null : col
}

/** Every renderable clip on the timeline, top-to-bottom track order preserved, invisible + text/lottie
 *  dropped (text = the editor's job; lottie can't be baked by ffmpeg). Returns the drop reasons too. */
function collectClips(timeline: Timeline): { clip: Clip; isAudioTrack: boolean }[] {
  const out: { clip: Clip; isAudioTrack: boolean }[] = []
  for (const t of timeline.tracks) {
    if (t.hidden) continue
    const isAudioTrack = t.type === 'audio'
    for (const clip of t.clips) {
      if (clip.mediaType === 'text' || clip.mediaType === 'lottie') continue
      if (!isAudioTrack && isInvisible(clip)) continue
      out.push({ clip, isAudioTrack })
    }
  }
  return out
}

/**
 * Group the timeline's clips into bake jobs. One job per distinct output file.
 * `manifest` supplies per-source duration (for full-length bakes) + hasAudio.
 */
export function planBakes(timeline: Timeline, manifest: MediaManifest, opts: PlanBakesOptions = {}): BakeJob[] {
  const fps = timeline.fps
  const jobs = new Map<string, BakeJob>()

  const sourceFrames = (mediaRef: string): number => {
    const e = entryFor(manifest, mediaRef)
    return e ? Math.max(0, sround(e.duration * fps)) : 0
  }

  for (const { clip, isAudioTrack } of collectClips(timeline)) {
    const isImage = clip.mediaType === 'image'
    const hasAudio = clipHasAudio(clip, manifest)
    const color = isAudioTrack ? null : gradeForClip(clip)
    const enh = hasAudio && !audioEnhanceIsIdentity(clip.audioEnhance) ? clip.audioEnhance! : null
    const flipH = !isAudioTrack && clip.transform.flipHorizontal
    const flipV = !isAudioTrack && clip.transform.flipVertical
    const speed = clip.speed

    // Mode: images are stills; a non-unit speed forces a per-clip segment (speed baked → no time-remap);
    // everything else shares a per-source file.
    const mode: BakeMode = isImage ? 'image' : speed !== 1 ? 'clip' : 'source'

    const colorKey = canon(color ?? undefined)
    const audioKey = canon(enh ?? undefined)
    const flipKey = `${flipH ? 'H' : ''}${flipV ? 'V' : ''}`

    const bakeKey =
      mode === 'clip'
        ? `clip:${clip.id}`
        : mode === 'image'
          ? `img|${clip.mediaRef}|${colorKey}|${flipKey}`
          : `${isAudioTrack ? 'a' : 'v'}|${clip.mediaRef}|${colorKey}|${audioKey}|${flipKey}`

    // Source window consumed by this clip.
    const clipIn = clip.trimStartFrame
    const clipOut = clip.trimStartFrame + sourceFramesConsumed(clip)

    const needsBake =
      mode === 'clip' || color !== null || !!enh || flipH || flipV || (isImage && (color !== null || flipH || flipV))

    const existing = jobs.get(bakeKey)
    if (existing) {
      existing.clipIds.push(clip.id)
      existing.inFrame = Math.min(existing.inFrame, clipIn)
      existing.outFrame = Math.max(existing.outFrame, clipOut)
      continue
    }

    // Baked window. `source`/`image` cover the used range (or whole source with fullLength); `clip`
    // covers exactly this clip's source span (speed baked, so the NLE plays it 1:1).
    let inFrame = clipIn
    let outFrame = clipOut
    if (mode !== 'clip' && opts.fullLength) {
      inFrame = 0
      outFrame = sourceFrames(clip.mediaRef)
    }
    // Referencing the original unchanged always maps to the whole file (baked frame 0 == source 0).
    if (!needsBake) {
      inFrame = 0
      outFrame = sourceFrames(clip.mediaRef)
    }

    jobs.set(bakeKey, {
      bakeKey,
      mediaRef: clip.mediaRef,
      mediaType: clip.mediaType,
      mode,
      clipIds: [clip.id],
      color: color ?? undefined,
      audioEnhance: enh ?? undefined,
      flipH,
      flipV,
      speed: mode === 'clip' ? speed : 1,
      inFrame,
      outFrame,
      hasAudio,
      needsBake
    })
  }

  return [...jobs.values()]
}

/** Map every clip id to its bake job (for the XML builder's clip → source lookup). */
export function clipJobIndex(jobs: BakeJob[]): Map<string, BakeJob> {
  const idx = new Map<string, BakeJob>()
  for (const job of jobs) for (const id of job.clipIds) idx.set(id, job)
  return idx
}
