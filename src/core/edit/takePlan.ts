// SPDX-License-Identifier: GPL-3.0-or-later
// Build the cleaned Timeline for ONE detected take, preserving the FULL multicam structure. Clones the
// current timeline (ALL tracks — frontal + lateral + audio, with per-clip color/keyframes) and ripple-
// deletes everything OUTSIDE the take's frame range plus the internal cuts, across all tracks in sync.
// Take/cut times come from the transcribed (reference) clip and are mapped to timeline frames via that
// clip's real placement (startFrame + trimStartFrame + speed), so it stays correct after multicam sync.
// Non-destructive w.r.t. the live timeline (throwaway EditorController on a clone). No IO.

import { EditorController } from '../controller/EditorController'
import { type Clip, type Timeline, clipEndFrame, timelineFrameForSourceSeconds, totalFrames } from '../model/timeline'
import type { PlannedCut, PlannedTake } from '../ai/takesPlan'

/** Map a SOURCE-time point (ms) of `refClip` to a timeline frame, clamped to the clip's visible range
 *  when it falls outside it (e.g. a span the multicam sync trim removed from the head/tail). */
function frameForMs(refClip: Clip, ms: number, fps: number): number {
  const f = timelineFrameForSourceSeconds(refClip, ms / 1000, fps)
  if (f != null) return f
  // Outside the visible window: before the trimmed-in point → clip start; after → clip end.
  return (ms / 1000) * fps <= refClip.trimStartFrame ? refClip.startFrame : clipEndFrame(refClip)
}

/** Build the cleaned Timeline for a single take by trimming a CLONE of the whole (multicam) timeline to
 *  the take's frame range across all tracks, then removing the internal cuts. `base` is the live timeline
 *  (all tracks, color-graded); `refClip` is the transcribed clip used to map take/cut source-ms → frames;
 *  `take`/`cuts` are absolute SOURCE-time spans in ms. Preserves both angles, audio, and per-clip color.
 *  Returns null when the take can't be mapped to a usable frame range (non-finite times, or a span that
 *  collapses outside the ref clip's visible window) — a degenerate range would otherwise ripple-delete
 *  the ENTIRE timeline (head [0,start) + tail [start,total) covers everything). */
export function buildTakeTimeline(base: Timeline, refClip: Clip, take: PlannedTake, cuts: PlannedCut[]): Timeline | null {
  const fps = base.fps
  const total = totalFrames(base)
  if (!Number.isFinite(take.startMs) || !Number.isFinite(take.endMs)) return null
  const tc = new EditorController(structuredClone(base))

  const clampFrame = (n: number): number => Math.max(0, Math.min(total, n))
  const takeStart = clampFrame(frameForMs(refClip, take.startMs, fps))
  const takeEnd = Math.max(takeStart, clampFrame(frameForMs(refClip, take.endMs, fps)))
  if (takeEnd <= takeStart) return null

  // Everything to REMOVE (timeline frames): the head before the take, the tail after it, and each internal
  // cut (clamped inside the take). Computed against the ORIGINAL `base`, then applied right-to-left so an
  // earlier (leftward) removal's frames stay valid after a later (rightward) one ripples the tail left.
  const removals: { startFrame: number; endFrame: number }[] = []
  if (takeStart > 0) removals.push({ startFrame: 0, endFrame: takeStart })
  if (takeEnd < total) removals.push({ startFrame: takeEnd, endFrame: total })
  for (const c of cuts) {
    const s = Math.max(takeStart, Math.min(takeEnd, frameForMs(refClip, c.startMs, fps)))
    const e = Math.max(takeStart, Math.min(takeEnd, frameForMs(refClip, c.endMs, fps)))
    if (e > s) removals.push({ startFrame: s, endFrame: e })
  }
  removals.sort((a, b) => b.startFrame - a.startFrame)
  // `undefined` trackIds = ALL tracks: keeps frontal/lateral/audio aligned, splits boundaries, closes gaps.
  for (const r of removals) tc.rippleDeleteRange(undefined, r.startFrame, r.endFrame)

  // Invariant: every track starts at the SAME frame (see resyncTrackHeads).
  const out = tc.getTimeline()
  resyncTrackHeads(out)
  return out
}

/** Re-sync tracks whose first clip lags behind the others. In a synced multicam take every angle + the
 *  audio start at the same real moment; if one track's earliest clip ends up at a later frame than the
 *  rest (a stray per-track leading gap — the "lateral out of sync" bug), that angle plays late. We pull
 *  each lagging track left to match the earliest track's start, which re-aligns the angles WITHOUT closing
 *  a leading gap that ALL tracks share (that would be an intentional intro gap — left untouched). Mutates
 *  in place; no-op when all tracks already share the same head. Also used to heal projects reopened from
 *  an older/edited state. */
export function resyncTrackHeads(tl: Timeline): void {
  const heads = tl.tracks
    .filter((t) => t.clips.length > 0)
    .map((t) => Math.min(...t.clips.map((c) => c.startFrame)))
  if (heads.length < 2) return
  const globalMin = Math.min(...heads)
  for (const t of tl.tracks) {
    if (t.clips.length === 0) continue
    const k = Math.min(...t.clips.map((c) => c.startFrame))
    if (k > globalMin) for (const c of t.clips) c.startFrame -= k - globalMin
  }
}
