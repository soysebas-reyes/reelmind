// SPDX-License-Identifier: GPL-3.0-or-later
// Shared multicam-cut primitive used by both the `cut_to_angle` AI tool and the
// renderer's `applyAutoAngles` button, so manual and agent-driven cuts behave identically.
//
// For a timeline range [fromFrame, toFrame) it isolates that segment on every angle clip (2 or 3:
// frontal / lateral / b-roll), then shows exactly one angle. Two modes:
//  - non-destructive (default): the hidden angles' segments get opacity 0 (reversible,
//    recolorable, surfaced correctly by composeFrame which skips opacity<=0 clips).
//  - destructive: the hidden angles' segments are removed, so the program literally alternates
//    fragments across the stacked tracks.

import { clipEndFrame } from '../model/timeline'
import { type EditorController } from '../controller/EditorController'

/** Split `clipId` so that the piece covering [fromFrame, toFrame) is isolated; return its id. */
function isolateSegment(
  c: EditorController,
  clipId: string,
  fromFrame: number,
  toFrame: number
): string | null {
  const clip = c.getClip(clipId)
  if (!clip) return null
  if (clip.startFrame >= toFrame || clipEndFrame(clip) <= fromFrame) return null // no overlap

  // Split off the part before fromFrame → segId becomes the piece starting at fromFrame.
  let segId = clipId
  if (clip.startFrame < fromFrame) {
    const rightId = c.splitClip(clipId, fromFrame)
    if (rightId) segId = rightId
  }
  // Split off the part at/after toFrame (no-op at a boundary); left (segId) is now [from, to).
  c.splitClip(segId, toFrame)
  return segId
}

function applyVisibility(
  c: EditorController,
  segId: string | null,
  show: boolean,
  destructive: boolean
): void {
  if (!segId) return
  if (show) {
    c.setClipProperties(segId, { opacity: 1 })
  } else if (destructive) {
    c.removeClip(segId)
  } else {
    c.setClipProperties(segId, { opacity: 0 })
  }
}

/** Show the angle at `chosenIndex` for [fromFrame, toFrame), hiding (or removing) the others. Works
 *  for any number of stacked angle tracks (2 or 3). Setting opacity 0 on EVERY non-chosen angle —
 *  rather than only the one above — makes the result independent of track stacking order. Caller is
 *  responsible for wrapping this in `runAs`/`transact` for a single undo step. */
export function cutRangeToAngles(
  c: EditorController,
  angleClipIds: string[],
  chosenIndex: number,
  fromFrame: number,
  toFrame: number,
  destructive = false
): void {
  if (fromFrame >= toFrame) return
  // Isolate the segment on every angle FIRST (splits are independent per track), then toggle
  // visibility — so a later split never re-targets an already-hidden segment id.
  const segs = angleClipIds.map((id) => isolateSegment(c, id, fromFrame, toFrame))
  segs.forEach((segId, i) => applyVisibility(c, segId, i === chosenIndex, destructive))
}

/** Split a track so the piece(s) covering [fromFrame, toFrame) are isolated; return their ids. A range
 *  can straddle a clip boundary when a track was cut into many pieces (the multicam whole-track case), so
 *  this isolates EVERY overlapping clip, not just the one at `fromFrame`. Snapshots the overlapping ids
 *  before splitting (splitClip mutates the track's clip list). */
function isolateRangeOnTrack(c: EditorController, trackId: string, fromFrame: number, toFrame: number): string[] {
  const track = c.getTrack(trackId)
  if (!track) return []
  const overlapping = track.clips
    .filter((cl) => cl.startFrame < toFrame && clipEndFrame(cl) > fromFrame)
    .map((cl) => cl.id)
  const segIds: string[] = []
  for (const id of overlapping) {
    const seg = isolateSegment(c, id, fromFrame, toFrame)
    if (seg) segIds.push(seg)
  }
  return segIds
}

/** Like `cutRangeToAngles` but addressed by TRACK: for [fromFrame, toFrame) it isolates the range across
 *  ALL clips of each angle track (so independently-cut tracks still cut cleanly across clip boundaries),
 *  then shows the angle at `chosenIndex` and hides/removes the rest. Returns false (a no-op skip) when
 *  fewer than two angle tracks actually have clips in the range. One undo step is the caller's job. */
export function cutRangeToAnglesByTrack(
  c: EditorController,
  angleTrackIds: string[],
  chosenIndex: number,
  fromFrame: number,
  toFrame: number,
  destructive = false
): boolean {
  if (fromFrame >= toFrame) return false
  // Isolate on every track FIRST (independent per track), then toggle visibility — so a later split never
  // re-targets an already-hidden segment id.
  const perTrackSegs = angleTrackIds.map((tid) => isolateRangeOnTrack(c, tid, fromFrame, toFrame))
  if (perTrackSegs.filter((segs) => segs.length > 0).length < 2) return false
  perTrackSegs.forEach((segs, i) => {
    for (const segId of segs) applyVisibility(c, segId, i === chosenIndex, destructive)
  })
  return true
}

/** Two-angle convenience wrapper kept for the `cut_to_angle` MCP tool. */
export function cutRangeToAngle(
  c: EditorController,
  frontalClipId: string,
  lateralClipId: string,
  fromFrame: number,
  toFrame: number,
  angle: 'frontal' | 'lateral',
  destructive = false
): void {
  cutRangeToAngles(c, [frontalClipId, lateralClipId], angle === 'frontal' ? 0 : 1, fromFrame, toFrame, destructive)
}
