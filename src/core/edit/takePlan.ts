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

/** The cuts to actually apply for a take: those inside it (by `takeIndex`) AND accepted in the review UI.
 *  `cutAccepted` is index-aligned with the WHOLE `cuts` array (the review's per-cut checkbox state), so a
 *  rejected cut is simply not passed to `buildTakeTimeline`. Pure — the store calls this in applyTakesPlan. */
export function acceptedCutsForTake(cuts: PlannedCut[], cutAccepted: boolean[], takeIndex: number): PlannedCut[] {
  return cuts.filter((cut, i) => cut.takeIndex === takeIndex && (cutAccepted[i] ?? true))
}

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

  // Clone before the in-place fixups: the controller's timeline is an immer product (frozen), so
  // mutating it directly would throw. The clone is also what gets handed to the new tab (no sharing).
  const out = structuredClone(tc.getTimeline())
  // Invariant: every track starts at the SAME frame (see resyncTrackHeads).
  resyncTrackHeads(out)
  // Every internal audio seam in a clean take is a real cut → ask the exporter for anti-click micro-fades.
  out.antiClickAudioFades = true
  return out
}

export interface LinkAlignmentReport {
  /** Link groups spanning ≥2 tracks that were checked. */
  groupsChecked: number
  /** Clips whose startFrame/trimStartFrame drift was corrected. */
  corrected: number
  /** Groups with non-uniform drift that could NOT be safely corrected (left untouched, only reported). */
  uncorrectable: number
}

/** Fragments of one link group on one track, sorted by timeline position. */
function groupFragmentsByTrack(tl: Timeline, groupId: string): Map<number, Clip[]> {
  const byTrack = new Map<number, Clip[]>()
  tl.tracks.forEach((t, ti) => {
    const frags = t.clips.filter((c) => c.linkGroupId === groupId).sort((a, b) => a.startFrame - b.startFrame)
    if (frags.length > 0) byTrack.set(ti, frags)
  })
  return byTrack
}

/** Uniform difference of `pick` across two equally-long fragment lists, or null when it varies. */
function uniformDelta(as: Clip[], bs: Clip[], pick: (c: Clip) => number): number | null {
  const d = pick(as[0]) - pick(bs[0])
  for (let i = 1; i < as.length; i++) if (pick(as[i]) - pick(bs[i]) !== d) return null
  return d
}

/** Safety net for the multicam sync invariant inside a freshly built take tab: clips sharing a
 *  `linkGroupId` are the SAME real moment seen from two angles, so after the per-take ripple every
 *  fragment pair must sit at the same timeline frame with the same source-in delta the BASE timeline
 *  had (the baked sync offset). Splits clone `linkGroupId`, so a group may hold several fragments per
 *  track. Only UNIFORM drift is corrected (whole-group shift of startFrame and/or trimStartFrame);
 *  anything non-uniform is reported as uncorrectable and left untouched — a partial fix would replace
 *  one desync with a subtler one. Mutates `built` in place (same style as resyncTrackHeads); no IO. */
export function verifyLinkedAlignment(base: Timeline, built: Timeline): LinkAlignmentReport {
  const report: LinkAlignmentReport = { groupsChecked: 0, corrected: 0, uncorrectable: 0 }
  const groupIds = new Set<string>()
  for (const t of built.tracks) for (const c of t.clips) if (c.linkGroupId) groupIds.add(c.linkGroupId)

  for (const groupId of groupIds) {
    const builtByTrack = groupFragmentsByTrack(built, groupId)
    if (builtByTrack.size < 2) continue
    report.groupsChecked++

    const baseByTrack = groupFragmentsByTrack(base, groupId)
    const trackIndexes = [...builtByTrack.keys()].sort((a, b) => a - b)
    const refIndex = trackIndexes[0]
    const refFrags = builtByTrack.get(refIndex) as Clip[]
    const refBaseHead = baseByTrack.get(refIndex)?.[0]
    // Mixed speeds make the linear source relation invalid — unverifiable, leave alone.
    const speeds = new Set(trackIndexes.flatMap((ti) => (builtByTrack.get(ti) as Clip[]).map((c) => c.speed)))
    if (speeds.size > 1) continue

    let groupBroken = false
    for (const ti of trackIndexes.slice(1)) {
      const frags = builtByTrack.get(ti) as Clip[]
      if (frags.length !== refFrags.length) {
        groupBroken = true
        continue
      }
      // 1) Positional drift: the whole angle sits `d` frames late/early vs the reference.
      const startDelta = uniformDelta(frags, refFrags, (c) => c.startFrame)
      if (startDelta === null) {
        groupBroken = true
        continue
      }
      if (startDelta !== 0) {
        for (const c of frags) c.startFrame -= startDelta
        report.corrected += frags.length
      }
      // 2) Source-in drift: the trim delta must still equal what the BASE (synced) timeline baked in.
      const baseHead = baseByTrack.get(ti)?.[0]
      const expectedTrimDelta =
        baseHead && refBaseHead ? baseHead.trimStartFrame - refBaseHead.trimStartFrame : null
      const trimDelta = uniformDelta(frags, refFrags, (c) => c.trimStartFrame)
      if (expectedTrimDelta === null || trimDelta === null) {
        if (trimDelta === null) groupBroken = true // varies per fragment → unsafe to touch
        continue
      }
      const err = trimDelta - expectedTrimDelta
      if (err !== 0) {
        if (frags.some((c) => c.trimStartFrame - err < 0)) {
          groupBroken = true // correction would need source material before frame 0
          continue
        }
        for (const c of frags) c.trimStartFrame -= err
        report.corrected += frags.length
      }
    }
    if (groupBroken) report.uncorrectable++
  }
  return report
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
