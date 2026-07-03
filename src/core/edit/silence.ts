// SPDX-License-Identifier: GPL-3.0-or-later
// Pure mapping from detected source-audio silence ranges (seconds) to timeline frame cuts for a
// clip, honoring the clip's trim and speed. Used by the `remove_silences` agent tool. No IO.

import { type Clip, clipEndFrame, sourceFramesConsumed } from '../model/timeline'

/** A silent span in the SOURCE media, in seconds. */
export interface SilenceSeconds {
  start: number
  end: number
}

/** A half-open [startFrame, endFrame) span on the timeline to cut out. */
export interface FrameCut {
  startFrame: number
  endFrame: number
}

export interface SilenceCutOptions {
  /** Keep this many seconds of audio around speech (shrinks each silence on both sides). */
  paddingSec?: number
  /** Ignore silences shorter than this many seconds (after padding). */
  minSilenceSec?: number
}

/** Map source silence ranges to timeline frame cuts for `clip`: pad inward, drop sub-minimum spans,
 *  clamp to the clip's visible body, and convert source-seconds → timeline-frames through the clip's
 *  trim and speed. Returned sorted DESCENDING by startFrame so a caller can apply them with
 *  left-shifting ripples without invalidating earlier (leftward) cuts. */
export function silencesToCuts(
  clip: Clip,
  silences: SilenceSeconds[],
  fps: number,
  opts: SilenceCutOptions = {}
): FrameCut[] {
  const padding = Math.max(0, opts.paddingSec ?? 0)
  const minSilence = Math.max(0, opts.minSilenceSec ?? 0)
  const speed = Math.max(clip.speed, 0.0001)
  const visStartFrame = clip.trimStartFrame
  const visEndFrame = clip.trimStartFrame + sourceFramesConsumed(clip)
  const clipStart = clip.startFrame
  const clipEnd = clipEndFrame(clip)

  const cuts: FrameCut[] = []
  for (const s of silences) {
    const startSec = s.start + padding
    const endSec = s.end - padding
    if (endSec - startSec < minSilence) continue
    // Clamp to the clip's visible source window (in source frames).
    const srcStart = Math.max(visStartFrame, startSec * fps)
    const srcEnd = Math.min(visEndFrame, endSec * fps)
    if (srcEnd <= srcStart) continue
    // Source frame → timeline frame through trim + speed.
    const tStart = Math.round(clipStart + (srcStart - clip.trimStartFrame) / speed)
    const tEnd = Math.round(clipStart + (srcEnd - clip.trimStartFrame) / speed)
    const startFrame = Math.max(clipStart, Math.min(tStart, clipEnd))
    const endFrame = Math.max(clipStart, Math.min(tEnd, clipEnd))
    if (endFrame > startFrame) cuts.push({ startFrame, endFrame })
  }
  cuts.sort((a, b) => b.startFrame - a.startFrame)
  return cuts
}

/** Resolve which clip `remove_silences` should target when the agent passes no clipId and nothing
 *  useful is selected. If exactly ONE track carries audible (video/audio) clips, its first clip is
 *  an unambiguous default; otherwise return the candidates so the agent can self-correct. Pure. */
export function pickDefaultSilenceTarget(
  tl: import('../model/timeline').Timeline
): { clipId: string } | { candidates: { trackId: string; trackIndex: number; firstClipId: string; clips: number }[] } {
  const audible = tl.tracks
    .map((t, trackIndex) => ({ t, trackIndex }))
    .filter(({ t }) => t.clips.some((cl) => cl.mediaType === 'video' || cl.mediaType === 'audio'))
  if (audible.length === 1) {
    const first = audible[0].t.clips.find((cl) => cl.mediaType === 'video' || cl.mediaType === 'audio')!
    return { clipId: first.id }
  }
  return {
    candidates: audible.map(({ t, trackIndex }) => ({
      trackId: t.id,
      trackIndex,
      firstClipId: t.clips.find((cl) => cl.mediaType === 'video' || cl.mediaType === 'audio')!.id,
      clips: t.clips.length
    }))
  }
}
