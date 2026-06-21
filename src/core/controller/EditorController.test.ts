// SPDX-License-Identifier: GPL-3.0-or-later
// Command-API tests: command results match the ported engines, every command is one
// undo step, undo/redo reverse exactly, and agent-driven edits are tagged.

import { describe, expect, it } from 'vitest'
import { makeSnapState } from '../engines/snapEngine'
import { type Timeline, clipEndFrame } from '../model/timeline'
import { EditorController } from './EditorController'

/** Build a controller seeded with one video and one audio track. */
function seeded(): { c: EditorController; v1: string; v2: string; a1: string } {
  const c = new EditorController()
  const v1 = c.addTrack('video')
  const v2 = c.addTrack('video')
  const a1 = c.addTrack('audio')
  // Clear the 3 setup undo steps so each test starts from a clean history.
  c.reset(c.getTimeline())
  return { c, v1, v2, a1 }
}

function clipsOf(tl: Timeline, trackId: string) {
  const t = tl.tracks.find((x) => x.id === trackId)
  return t ? t.clips : []
}

describe('EditorController — tracks', () => {
  it('keeps visual tracks above audio regardless of requested index', () => {
    const c = new EditorController()
    const a = c.addTrack('audio')
    const v = c.addTrack('video', 5) // requested past the end → clamps above audio
    const tl = c.getTimeline()
    expect(tl.tracks.map((t) => t.id)).toEqual([v, a])
    expect(tl.tracks.map((t) => t.type)).toEqual(['video', 'audio'])
  })

  it('removeTrack drops the track', () => {
    const { c, v2 } = seeded()
    c.removeTrack(v2)
    expect(c.getTimeline().tracks.some((t) => t.id === v2)).toBe(false)
  })

  it('toggles track flags', () => {
    const { c, v1 } = seeded()
    c.setTrackMuted(v1)
    expect(c.getTrack(v1)?.muted).toBe(true)
    c.setTrackMuted(v1, false)
    expect(c.getTrack(v1)?.muted).toBe(false)
    c.setTrackHidden(v1, true)
    expect(c.getTrack(v1)?.hidden).toBe(true)
  })
})

describe('EditorController — addClip (overwrite)', () => {
  it('places a clip and returns its id', () => {
    const { c, v1 } = seeded()
    const id = c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    expect(id).toBe('A')
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1)
  })

  it('returns null for a missing track', () => {
    const { c } = seeded()
    expect(c.addClip({ trackId: 'nope', mediaRef: 'm', startFrame: 0, durationFrames: 10 })).toBeNull()
  })

  it('overwrites by trimming a left-overlapping neighbor', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 50, durationFrames: 100, id: 'B' })
    const clips = clipsOf(c.getTimeline(), v1)
    expect(clips.map((x) => [x.id, x.startFrame, x.durationFrames])).toEqual([
      ['A', 0, 50],
      ['B', 50, 100]
    ])
  })

  it('overwrites by splitting an enveloping neighbor', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 200, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 50, durationFrames: 50, id: 'B' })
    const clips = clipsOf(c.getTimeline(), v1)
    expect(clips.map((x) => [x.startFrame, x.durationFrames])).toEqual([
      [0, 50], // A left half
      [50, 50], // B
      [100, 100] // A right fragment
    ])
    expect(clips).toHaveLength(3)
  })
})

describe('EditorController — move', () => {
  it('moves a clip to another track at an exact frame', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.moveClip('A', v2, 100)
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(0)
    const moved = clipsOf(c.getTimeline(), v2)[0]
    expect([moved.id, moved.startFrame]).toEqual(['A', 100])
  })

  it('refuses a move onto an incompatible (audio) track', () => {
    const { c, v1, a1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.moveClip('A', a1, 0)
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1)
    expect(clipsOf(c.getTimeline(), a1)).toHaveLength(0)
  })
})

describe('EditorController — trim', () => {
  it('trimClipStart shifts start and shrinks duration (speed 1)', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.trimClipStart('A', 20)
    const a = c.getClip('A')!
    expect([a.startFrame, a.durationFrames, a.trimStartFrame]).toEqual([20, 80, 20])
  })

  it('trimClipEnd shrinks duration from the tail', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.trimClipEnd('A', 30)
    const a = c.getClip('A')!
    expect([a.startFrame, a.durationFrames, a.trimEndFrame]).toEqual([0, 70, 30])
  })

  it('trim converts source frames to timeline frames by speed', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A', speed: 2 })
    c.trimClipStart('A', 40) // 40 source / 2 = 20 timeline
    const a = c.getClip('A')!
    expect([a.startFrame, a.durationFrames, a.trimStartFrame]).toEqual([20, 80, 40])
  })
})

describe('EditorController — split', () => {
  it('splits at a frame, preserving total coverage (speed 1)', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    const rightId = c.splitClip('A', 30)
    expect(rightId).not.toBeNull()
    const left = c.getClip('A')!
    const right = c.getClip(rightId!)!
    expect([left.durationFrames, left.trimEndFrame]).toEqual([30, 70])
    expect([right.startFrame, right.durationFrames, right.trimStartFrame]).toEqual([30, 70, 30])
    expect(clipEndFrame(right)).toBe(100)
  })

  it('split respects speed for source-frame trims', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A', speed: 2 })
    const rightId = c.splitClip('A', 40)!
    const left = c.getClip('A')!
    const right = c.getClip(rightId)!
    expect([left.durationFrames, left.trimEndFrame]).toEqual([40, 120]) // (100-40)*2
    expect([right.startFrame, right.durationFrames, right.trimStartFrame]).toEqual([40, 60, 80]) // 40*2
  })

  it('split outside the clip body is a no-op', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    expect(c.splitClip('A', 0)).toBeNull()
    expect(c.splitClip('A', 100)).toBeNull()
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1)
  })
})

describe('EditorController — ripple delete', () => {
  it('closes the gap on the edited track and shifts a sync-locked follower', () => {
    const { c, v1, a1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 50, durationFrames: 50, id: 'B' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 100, durationFrames: 50, id: 'C' })
    c.addClip({ trackId: a1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'X', mediaType: 'audio' })
    c.addClip({ trackId: a1, mediaRef: 'm', startFrame: 100, durationFrames: 50, id: 'Y', mediaType: 'audio' })

    const outcome = c.rippleDelete(['B'])
    expect(outcome.ok).toBe(true)
    expect(outcome.removedFrames).toBe(50)
    expect(outcome.shiftedClips).toBe(2) // C and Y

    expect(clipsOf(c.getTimeline(), v1).map((x) => [x.id, x.startFrame])).toEqual([
      ['A', 0],
      ['C', 50]
    ])
    expect(clipsOf(c.getTimeline(), a1).map((x) => [x.id, x.startFrame])).toEqual([
      ['X', 0],
      ['Y', 50]
    ])
  })

  it('refuses (without mutating) when a sync-locked follower cannot absorb the shift', () => {
    const { c, v1, a1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 100, durationFrames: 100, id: 'B' }) // range [100,200)
    c.addClip({ trackId: a1, mediaRef: 'm', startFrame: 0, durationFrames: 160, id: 'X', mediaType: 'audio' })
    c.addClip({ trackId: a1, mediaRef: 'm', startFrame: 200, durationFrames: 50, id: 'Y', mediaType: 'audio' })

    const before = JSON.parse(JSON.stringify(c.getTimeline()))
    const outcome = c.rippleDelete(['B'])
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/room to ripple/)
    expect(c.getTimeline()).toEqual(before) // unchanged
  })
})

describe('EditorController — speed', () => {
  it('recomputes duration and ripples the contiguous chain', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 100, durationFrames: 50, id: 'B' })
    c.setClipSpeed('A', 2) // 100 frames of source at 2x → 50 frames
    const a = c.getClip('A')!
    const b = c.getClip('B')!
    expect([a.durationFrames, a.speed]).toEqual([50, 2])
    expect(b.startFrame).toBe(50) // pulled back by the 50-frame shrink
  })
})

describe('EditorController — properties', () => {
  it('applies whitelisted appearance edits', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.setClipProperties('A', { volume: 0.5, opacity: 0.8, fadeInFrames: 10 })
    const a = c.getClip('A')!
    expect([a.volume, a.opacity, a.fadeInFrames]).toEqual([0.5, 0.8, 10])
  })

  it('clamps fades to the clip duration', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 40, id: 'A' })
    c.setClipProperties('A', { fadeInFrames: 999 })
    expect(c.getClip('A')!.fadeInFrames).toBe(40)
  })
})

describe('EditorController — undo / redo', () => {
  it('treats each command as exactly one undo step and reverses a 3-track sequence exactly', () => {
    const c = new EditorController()
    const states: Timeline[] = [c.getTimeline()]
    const snap = () => states.push(c.getTimeline())

    const v1 = c.addTrack('video')
    snap()
    const v2 = c.addTrack('video')
    snap()
    const a1 = c.addTrack('audio')
    snap()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    snap()
    c.addClip({ trackId: v2, mediaRef: 'm', startFrame: 20, durationFrames: 80, id: 'B' })
    snap()
    c.addClip({ trackId: a1, mediaRef: 'm', startFrame: 0, durationFrames: 200, id: 'C', mediaType: 'audio' })
    snap()
    c.moveClip('A', v1, 40)
    snap()
    c.trimClipEnd('A', 10)
    snap()
    c.splitClip('B', 60)
    snap()
    c.rippleDelete(['A'])
    snap()

    // Undo every step: each must land exactly on the prior captured state.
    for (let i = states.length - 1; i >= 1; i--) {
      expect(c.getTimeline()).toEqual(states[i])
      expect(c.undo()).toBe(true)
    }
    expect(c.getTimeline()).toEqual(states[0])
    expect(c.undo()).toBe(false)

    // Redo every step.
    for (let i = 1; i < states.length; i++) {
      expect(c.redo()).toBe(true)
      expect(c.getTimeline()).toEqual(states[i])
    }
    expect(c.canRedo()).toBe(false)
  })

  it('a new edit after undo clears the redo stack', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 100, durationFrames: 50, id: 'B' })
    c.undo()
    expect(c.canRedo()).toBe(true)
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 200, durationFrames: 50, id: 'D' })
    expect(c.canRedo()).toBe(false)
  })

  it('groups a transaction into a single undo step', () => {
    const { c, v1 } = seeded()
    const before = JSON.parse(JSON.stringify(c.getTimeline()))
    c.transact('Batch', () => {
      c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
      c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 50, durationFrames: 50, id: 'B' })
    })
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(2)
    expect(c.undo()).toBe(true)
    expect(c.getTimeline()).toEqual(before) // one undo reverses both
  })
})

describe('EditorController — origin tagging', () => {
  it('tags agent-driven edits', () => {
    const { c, v1 } = seeded()
    c.runAs('agent', () => {
      c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    })
    expect(c.snapshot().undoOrigin).toBe('agent')
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 100, durationFrames: 50, id: 'B' })
    expect(c.snapshot().undoOrigin).toBe('user')
  })
})

describe('EditorController — change notifications', () => {
  it('emits edit / view / load', () => {
    const c = new EditorController()
    const kinds: string[] = []
    c.subscribe((k) => kinds.push(k))
    const v1 = c.addTrack('video')
    c.seek(30)
    c.select(['x'])
    c.load(c.getTimeline())
    expect(kinds).toContain('edit')
    expect(kinds).toContain('view')
    expect(kinds).toContain('load')
    expect(v1).toBeTruthy()
  })

  it('seek and selection do not create undo steps', () => {
    const c = new EditorController()
    c.seek(50)
    c.select(['a'])
    expect(c.canUndo()).toBe(false)
    expect(c.getCurrentFrame()).toBe(50)
  })
})

describe('EditorController — snapping', () => {
  it('snaps a dragged start to a nearby clip edge', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' }) // edge at 100
    const state = makeSnapState()
    const result = c.snapMoveFrame({
      position: 98,
      durationFrames: 50,
      pixelsPerFrame: 4, // threshold 8px / 4 = 2 frames
      state,
      excludeClipIds: new Set(['B']),
      includePlayhead: false
    })
    expect(result).not.toBeNull()
    expect(result!.frame).toBe(100)
    expect(v2).toBeTruthy()
  })
})

/** Run an identical, deterministic edit script (explicit ids, no split → no random ids). */
function buildScript(c: EditorController): void {
  const v1 = c.addTrack('video')
  const v2 = c.addTrack('video')
  const a1 = c.addTrack('audio')
  c.addClip({ trackId: v1, mediaRef: 'm1', startFrame: 0, durationFrames: 100, id: 'A' })
  c.addClip({ trackId: v2, mediaRef: 'm2', startFrame: 30, durationFrames: 120, id: 'B' })
  c.addClip({ trackId: a1, mediaRef: 'm3', startFrame: 0, durationFrames: 200, id: 'C', mediaType: 'audio' })
  c.moveClip('A', v1, 50)
  c.trimClipEnd('A', 15)
  c.rippleDelete(['B'])
}

describe('EditorController — agent parity & persistence', () => {
  it('an agent-driven run produces the same timeline as a user-driven run', () => {
    const user = new EditorController()
    buildScript(user)

    const agent = new EditorController()
    agent.runAs('agent', () => buildScript(agent))

    // Track ids are random UUIDs; normalize them to positions. Everything that the edit
    // commands actually compute (clips, trims, starts, durations) must match exactly.
    const norm = (c: EditorController) => {
      const tl = c.getTimeline()
      return { ...tl, tracks: tl.tracks.map((t, i) => ({ ...t, id: `t${i}` })) }
    }
    expect(norm(agent)).toEqual(norm(user))
    expect(agent.snapshot().undoOrigin).toBe('agent')
    expect(user.snapshot().undoOrigin).toBe('user')
  })

  it('reload restores the timeline exactly (JSON round-trip through load)', () => {
    const c = new EditorController()
    buildScript(c)
    const saved = JSON.parse(JSON.stringify(c.getTimeline())) as Timeline

    const reopened = new EditorController()
    reopened.load(saved)
    expect(reopened.getTimeline()).toEqual(c.getTimeline())
    expect(reopened.canUndo()).toBe(false) // history reset on load
  })
})

describe('EditorController — color grading (P9.5)', () => {
  it('merges partial color edits as one undo step and reverses exactly', () => {
    const c = new EditorController()
    const trackId = c.addTrack('video')
    const clipId = c.addClip({ trackId, mediaRef: 'a', startFrame: 0, durationFrames: 60 })!
    c.reset(c.getTimeline()) // clean the add-track/add-clip history

    c.setClipColor(clipId, { saturation: 0.88 })
    c.setClipColor(clipId, { contrast: 1.2 })
    const color = c.getClip(clipId)!.color!
    expect(color.saturation).toBe(0.88) // preserved across the second edit (merge, not reset)
    expect(color.contrast).toBe(1.2)
    expect(color.exposure).toBe(0) // untouched fields keep neutral defaults

    expect(c.undo()).toBe(true) // one undo step per setClipColor
    expect(c.getClip(clipId)!.color!.contrast).toBe(1) // second edit reversed
    expect(c.getClip(clipId)!.color!.saturation).toBe(0.88) // first edit intact
  })

  it('persists color through a JSON load round-trip', () => {
    const c = new EditorController()
    const trackId = c.addTrack('video')
    const clipId = c.addClip({ trackId, mediaRef: 'a', startFrame: 0, durationFrames: 60 })!
    c.setClipColor(clipId, { saturation: 0.88, shadows: 8.6, lutRef: 'preset:guillermo-frontal-v1', lutIntensity: 0.5 })
    const saved = JSON.parse(JSON.stringify(c.getTimeline())) as Timeline

    const reopened = new EditorController()
    reopened.load(saved)
    const color = reopened.getClip(clipId)!.color!
    expect(color.saturation).toBe(0.88)
    expect(color.shadows).toBe(8.6)
    expect(color.lutRef).toBe('preset:guillermo-frontal-v1')
    expect(color.lutIntensity).toBe(0.5)
  })
})
