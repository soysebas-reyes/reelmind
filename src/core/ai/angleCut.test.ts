// SPDX-License-Identifier: GPL-3.0-or-later
// The shared multicam-cut primitive: isolate a range on two aligned tracks and show one angle,
// either non-destructively (opacity 0 on the hidden segment) or destructively (remove it).

import { describe, expect, it } from 'vitest'
import { EditorController } from '../controller/EditorController'
import { type Timeline, clipEndFrame } from '../model/timeline'
import { composeFrame } from '../preview/compositor'
import { cutRangeToAngle, cutRangeToAngles, cutRangeToAnglesByTrack } from './angleCut'

/** Two video tracks (frontal on top, lateral below), each one full-length clip aligned at frame 0. */
function stacked(): { c: EditorController; frontalTrack: string; lateralTrack: string } {
  const c = new EditorController()
  const frontalTrack = c.addTrack('video')
  const lateralTrack = c.addTrack('video')
  c.addClip({ trackId: frontalTrack, mediaRef: 'frontal', startFrame: 0, durationFrames: 300, id: 'F' })
  c.addClip({ trackId: lateralTrack, mediaRef: 'lateral', startFrame: 0, durationFrames: 300, id: 'L' })
  c.reset(c.getTimeline())
  return { c, frontalTrack, lateralTrack }
}

function clipCovering(tl: Timeline, trackId: string, frame: number) {
  const t = tl.tracks.find((x) => x.id === trackId)
  return t?.clips.find((cl) => frame >= cl.startFrame && frame < clipEndFrame(cl)) ?? null
}

describe('cutRangeToAngle', () => {
  it('non-destructive: hides the other angle with opacity 0, keeps both clips', () => {
    const { c, frontalTrack, lateralTrack } = stacked()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngle(c, 'F', 'L', 100, 200, 'lateral', false)))
    const tl = c.getTimeline()
    // Both tracks split into 3 segments.
    expect(tl.tracks.find((t) => t.id === frontalTrack)?.clips).toHaveLength(3)
    expect(tl.tracks.find((t) => t.id === lateralTrack)?.clips).toHaveLength(3)
    // Mid segment: frontal hidden, lateral shown.
    expect(clipCovering(tl, frontalTrack, 150)?.opacity).toBe(0)
    expect(clipCovering(tl, lateralTrack, 150)?.opacity).toBe(1)
    // Compositor shows only the lateral angle at frame 150.
    expect(composeFrame(tl, 150).visual.map((l) => l.mediaRef)).toEqual(['lateral'])
  })

  it('destructive: removes the hidden angle segment, leaving a gap that reveals the other', () => {
    const { c, frontalTrack, lateralTrack } = stacked()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngle(c, 'F', 'L', 100, 200, 'lateral', true)))
    const tl = c.getTimeline()
    // Frontal lost its mid segment (gap at [100,200)); lateral keeps all three.
    expect(clipCovering(tl, frontalTrack, 150)).toBeNull()
    expect(clipCovering(tl, frontalTrack, 50)).not.toBeNull()
    expect(clipCovering(tl, frontalTrack, 250)).not.toBeNull()
    expect(clipCovering(tl, lateralTrack, 150)?.mediaRef).toBe('lateral')
    // Only the lateral angle composites at frame 150; frontal still shows at 50.
    expect(composeFrame(tl, 150).visual.map((l) => l.mediaRef)).toEqual(['lateral'])
    expect(composeFrame(tl, 50).visual.map((l) => l.mediaRef)).toContain('frontal')
  })

  it('keeps the chosen (frontal) angle and drops the lateral segment when angle=frontal', () => {
    const { c, frontalTrack, lateralTrack } = stacked()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngle(c, 'F', 'L', 100, 200, 'frontal', true)))
    const tl = c.getTimeline()
    expect(clipCovering(tl, lateralTrack, 150)).toBeNull()
    expect(clipCovering(tl, frontalTrack, 150)?.mediaRef).toBe('frontal')
  })

  it('collapses to a single undo step (2 angles)', () => {
    const { c, frontalTrack, lateralTrack } = stacked()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngle(c, 'F', 'L', 100, 200, 'lateral', true)))
    expect(c.canUndo()).toBe(true)
    c.undo()
    // Back to the two original full-length clips (one per track), so a single undo reverts the cut.
    const tl = c.getTimeline()
    expect(tl.tracks.find((t) => t.id === frontalTrack)?.clips).toHaveLength(1)
    expect(tl.tracks.find((t) => t.id === lateralTrack)?.clips).toHaveLength(1)
    expect(clipCovering(tl, frontalTrack, 150)?.mediaRef).toBe('frontal')
    // Both present and stacked back-to-front, frontal (top track) drawn last.
    expect(composeFrame(tl, 150).visual.map((l) => l.mediaRef)).toEqual(['lateral', 'frontal'])
  })
})

/** Three stacked video tracks (frontal / lateral / b-roll), each one full-length clip aligned at 0. */
function stacked3(): { c: EditorController; tracks: string[] } {
  const c = new EditorController()
  const t0 = c.addTrack('video')
  const t1 = c.addTrack('video')
  const t2 = c.addTrack('video')
  c.addClip({ trackId: t0, mediaRef: 'frontal', startFrame: 0, durationFrames: 300, id: 'F' })
  c.addClip({ trackId: t1, mediaRef: 'lateral', startFrame: 0, durationFrames: 300, id: 'L' })
  c.addClip({ trackId: t2, mediaRef: 'broll', startFrame: 0, durationFrames: 300, id: 'B' })
  c.reset(c.getTimeline())
  return { c, tracks: [t0, t1, t2] }
}

describe('cutRangeToAngles (3 angles)', () => {
  it('non-destructive: shows only the chosen angle, hides the other two with opacity 0', () => {
    const { c, tracks } = stacked3()
    // Choose the b-roll (index 2) for [100,200).
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngles(c, ['F', 'L', 'B'], 2, 100, 200, false)))
    const tl = c.getTimeline()
    for (const t of tracks) expect(tl.tracks.find((x) => x.id === t)?.clips).toHaveLength(3)
    expect(clipCovering(tl, tracks[0], 150)?.opacity).toBe(0) // frontal hidden
    expect(clipCovering(tl, tracks[1], 150)?.opacity).toBe(0) // lateral hidden
    expect(clipCovering(tl, tracks[2], 150)?.opacity).toBe(1) // b-roll shown
    expect(composeFrame(tl, 150).visual.map((l) => l.mediaRef)).toEqual(['broll'])
  })

  it('destructive: removes the two non-chosen segments, leaving only the chosen angle', () => {
    const { c, tracks } = stacked3()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngles(c, ['F', 'L', 'B'], 1, 100, 200, true)))
    const tl = c.getTimeline()
    expect(clipCovering(tl, tracks[0], 150)).toBeNull() // frontal removed in range
    expect(clipCovering(tl, tracks[2], 150)).toBeNull() // b-roll removed in range
    expect(clipCovering(tl, tracks[1], 150)?.mediaRef).toBe('lateral')
    expect(composeFrame(tl, 150).visual.map((l) => l.mediaRef)).toEqual(['lateral'])
  })

  it('collapses a 3-angle cut to a single undo step', () => {
    const { c, tracks } = stacked3()
    c.runAs('user', () => c.transact('cut', () => cutRangeToAngles(c, ['F', 'L', 'B'], 2, 100, 200, false)))
    c.undo()
    const tl = c.getTimeline()
    for (const t of tracks) expect(tl.tracks.find((x) => x.id === t)?.clips).toHaveLength(1)
  })
})

// Whole-track angle cuts: a frontal track cut into MANY pieces (the user removed bad takes) must cut
// cleanly even when a segment straddles a clip boundary. cutRangeToAnglesByTrack isolates the range
// across ALL overlapping clips of each track, not just the one at `fromFrame`.
describe('cutRangeToAnglesByTrack (whole-track, crosses clip boundaries)', () => {
  /** Frontal track cut into two pieces [0,150)+[150,300); lateral one full clip [0,300). */
  function split(): { c: EditorController; frontalTrack: string; lateralTrack: string } {
    const c = new EditorController()
    const frontalTrack = c.addTrack('video')
    const lateralTrack = c.addTrack('video')
    c.addClip({ trackId: frontalTrack, mediaRef: 'frontal', startFrame: 0, durationFrames: 150, id: 'F1' })
    c.addClip({ trackId: frontalTrack, mediaRef: 'frontal', startFrame: 150, durationFrames: 150, id: 'F2' })
    c.addClip({ trackId: lateralTrack, mediaRef: 'lateral', startFrame: 0, durationFrames: 300, id: 'L' })
    c.reset(c.getTimeline())
    return { c, frontalTrack, lateralTrack }
  }

  it('hides BOTH frontal pieces within [100,200) (straddles the 150 boundary), shows lateral', () => {
    const { c, frontalTrack, lateralTrack } = split()
    const ok = c.runAs('user', () =>
      c.transact('cut', () => cutRangeToAnglesByTrack(c, [frontalTrack, lateralTrack], 1, 100, 200, false))
    )
    expect(ok).toBe(true)
    const tl = c.getTimeline()
    // Every frontal sub-segment inside the range is hidden; outside is visible.
    expect(clipCovering(tl, frontalTrack, 120)?.opacity).toBe(0) // first piece, in range
    expect(clipCovering(tl, frontalTrack, 180)?.opacity).toBe(0) // second piece, in range
    expect(clipCovering(tl, frontalTrack, 50)?.opacity).toBe(1)
    expect(clipCovering(tl, frontalTrack, 250)?.opacity).toBe(1)
    expect(clipCovering(tl, lateralTrack, 150)?.opacity).toBe(1)
    // Only the lateral angle composites across the whole [100,200) range, including the old boundary.
    expect(composeFrame(tl, 120).visual.map((l) => l.mediaRef)).toEqual(['lateral'])
    expect(composeFrame(tl, 180).visual.map((l) => l.mediaRef)).toEqual(['lateral'])
  })

  it('returns false (skip) when fewer than two tracks have clips in the range', () => {
    const { c, frontalTrack, lateralTrack } = split()
    // A range past the end of every clip → no overlaps anywhere.
    const ok = c.runAs('user', () =>
      c.transact('cut', () => cutRangeToAnglesByTrack(c, [frontalTrack, lateralTrack], 0, 400, 500, false))
    )
    expect(ok).toBe(false)
  })
})

// Regression for "every angle change restarts the video from the beginning": applying the FULL plan
// (several sequential cuts, like applyPlanCuts does) must keep the program's SOURCE time continuous —
// each segment shows the source at frame/fps, NOT at ~0.
describe('sequential plan cuts keep source continuity (no per-segment restart)', () => {
  function applyPlan(
    c: EditorController,
    frontalTrack: string,
    lateralTrack: string,
    segs: { from: number; to: number; track: string }[]
  ): void {
    c.runAs('user', () =>
      c.transact('plan', () => {
        for (const s of segs) {
          const tl = c.getTimeline()
          const fId = clipCovering(tl, frontalTrack, s.from)?.id
          const lId = clipCovering(tl, lateralTrack, s.from)?.id
          if (!fId || !lId) continue
          cutRangeToAngles(c, [fId, lId], s.track === frontalTrack ? 0 : 1, s.from, s.to, true)
        }
      })
    )
  }

  it('F,L,F across cuts at 100 and 200 stays continuous (sourceSeconds == frame/fps)', () => {
    const { c, frontalTrack, lateralTrack } = stacked()
    const fps = c.getTimeline().fps
    applyPlan(c, frontalTrack, lateralTrack, [
      { from: 0, to: 100, track: frontalTrack },
      { from: 100, to: 200, track: lateralTrack },
      { from: 200, to: 300, track: frontalTrack }
    ])
    const tl = c.getTimeline()
    for (const f of [10, 50, 99, 110, 150, 199, 210, 260, 299]) {
      const layers = composeFrame(tl, f).visual
      expect(layers).toHaveLength(1)
      expect(layers[0].sourceSeconds).toBeCloseTo(f / fps, 5)
    }
  })
})
