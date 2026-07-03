// SPDX-License-Identifier: GPL-3.0-or-later
// Command-API tests: command results match the ported engines, every command is one
// undo step, undo/redo reverse exactly, and agent-driven edits are tagged.

import { describe, expect, it } from 'vitest'
import { makeSnapState } from '../engines/snapEngine'
import { type Timeline, clipEndFrame, opacityAt } from '../model/timeline'
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

  it('sets, finds, and cycles multicam track roles', () => {
    const { c, v1, v2 } = seeded()
    expect(c.getTrack(v1)?.role).toBeUndefined()
    c.setTrackRole(v1, 'frontal')
    c.setTrackRole(v2, 'lateral')
    expect(c.getTrackByRole('frontal')?.id).toBe(v1)
    expect(c.getTrackByRole('lateral')?.id).toBe(v2)
    // cycle: undefined → frontal → lateral → broll → undefined
    const a1Track = c.getTimeline().tracks.find((t) => t.type === 'audio')!.id
    c.cycleTrackRole(a1Track)
    expect(c.getTrack(a1Track)?.role).toBe('frontal')
    c.cycleTrackRole(a1Track)
    expect(c.getTrack(a1Track)?.role).toBe('lateral')
    c.cycleTrackRole(a1Track)
    expect(c.getTrack(a1Track)?.role).toBe('broll')
    c.cycleTrackRole(a1Track)
    expect(c.getTrack(a1Track)?.role).toBeUndefined()
  })

  it('getTrackOfClip returns the owning track', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'X' })
    expect(c.getTrackOfClip('X')?.id).toBe(v1)
    expect(c.getTrackOfClip('nope')).toBeNull()
  })

  it('setClipSourceWindow sets trim in-point and duration, keeping startFrame', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 300, id: 'S' })
    c.setClipSourceWindow('S', 24, 120)
    const clip = c.getClip('S')!
    expect(clip.startFrame).toBe(0)
    expect(clip.trimStartFrame).toBe(24)
    expect(clip.durationFrames).toBe(120)
  })
})

describe('EditorController — razorAtPlayhead (manual simultaneous split)', () => {
  it('splits the clip covering the playhead on every track in ONE undo step', () => {
    const { c, v1, v2, a1 } = seeded()
    // Aligned multicam: frontal + lateral + audio all spanning [0,300).
    c.addClip({ trackId: v1, mediaRef: 'f', startFrame: 0, durationFrames: 300, id: 'F' })
    c.addClip({ trackId: v2, mediaRef: 'l', startFrame: 0, durationFrames: 300, id: 'L' })
    c.addClip({ trackId: a1, mediaRef: 'a', mediaType: 'audio', startFrame: 0, durationFrames: 300, id: 'A' })
    c.reset(c.getTimeline())

    c.seek(120)
    const created = c.razorAtPlayhead()
    expect(created).toHaveLength(3) // one new right-half per track
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(2)
    expect(clipsOf(c.getTimeline(), v2)).toHaveLength(2)
    expect(clipsOf(c.getTimeline(), a1)).toHaveLength(2)
    // The split is at frame 120 on every track.
    for (const tid of [v1, v2, a1]) {
      expect(clipsOf(c.getTimeline(), tid).some((cl) => cl.startFrame === 120)).toBe(true)
    }
    // One undo reverts the whole simultaneous cut.
    c.undo()
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1)
    expect(clipsOf(c.getTimeline(), v2)).toHaveLength(1)
    expect(clipsOf(c.getTimeline(), a1)).toHaveLength(1)
  })

  it('does not split a track whose clip does not cover the playhead', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'f', startFrame: 0, durationFrames: 300, id: 'F' })
    c.addClip({ trackId: v2, mediaRef: 'l', startFrame: 200, durationFrames: 100, id: 'L' }) // [200,300)
    c.reset(c.getTimeline())
    c.seek(120) // inside F, before L
    const created = c.razorAtPlayhead()
    expect(created).toHaveLength(1)
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(2)
    expect(clipsOf(c.getTimeline(), v2)).toHaveLength(1)
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

describe('EditorController — project settings', () => {
  it('setProjectSettings adopts resolution + fps in one undo step and marks configured', () => {
    const c = new EditorController()
    expect(c.getTimeline().settingsConfigured).toBe(false)
    c.setProjectSettings(3840, 2160, 25)
    const tl = c.getTimeline()
    expect([tl.width, tl.height, tl.fps]).toEqual([3840, 2160, 25])
    expect(tl.settingsConfigured).toBe(true)
    expect(c.undo()).toBe(true) // single step
    expect([c.getTimeline().width, c.getTimeline().settingsConfigured]).toEqual([1920, false])
  })
})

describe('EditorController — insertClips / duplicateClips (paste machinery)', () => {
  it('inserts deep copies with fresh ids, preserving appearance fields and overwriting the landing zone', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 60, id: 'SRC' })
    c.setClipProperties('SRC', { opacity: 0.4, fadeInFrames: 12 })
    c.setClipColor('SRC', { saturation: 0.7 })
    c.addClip({ trackId: v1, mediaRef: 'other', startFrame: 100, durationFrames: 60, id: 'VICTIM' })

    const src = c.getClip('SRC')!
    const [newId] = c.insertClips([{ clip: structuredClone(src), trackId: v1, startFrame: 90 }])
    const pasted = c.getClip(newId)!
    expect(pasted.id).not.toBe('SRC')
    expect(pasted.opacity).toBe(0.4)
    expect(pasted.fadeInFrames).toBe(12)
    expect(pasted.color?.saturation).toBe(0.7)
    expect(pasted.startFrame).toBe(90)
    // Overwrite semantics: VICTIM was trimmed/split by the landing region [90,150).
    const victim = c.getClip('VICTIM')
    expect(victim === null || victim.startFrame >= 150 || clipEndFrame(victim) <= 90).toBe(true)
  })

  it('one undo step reverts the whole batch', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'a', startFrame: 0, durationFrames: 30, id: 'A' })
    const a = structuredClone(c.getClip('A')!)
    c.reset(c.getTimeline())
    c.insertClips([
      { clip: a, trackId: v1, startFrame: 200 },
      { clip: a, trackId: v2, startFrame: 300 }
    ])
    expect(c.getTrack(v1)!.clips).toHaveLength(2)
    expect(c.getTrack(v2)!.clips).toHaveLength(1)
    expect(c.undo()).toBe(true)
    expect(c.getTrack(v1)!.clips).toHaveLength(1)
    expect(c.getTrack(v2)!.clips).toHaveLength(0)
    expect(c.canUndo()).toBe(false) // exactly one step
  })

  it('remaps a linkGroup shared inside the batch and drops a singleton linkGroup', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'f', startFrame: 0, durationFrames: 60, id: 'F' })
    c.addClip({ trackId: v2, mediaRef: 'l', startFrame: 0, durationFrames: 60, id: 'L' })
    c.setClipProperties('F', { linkGroupId: 'G1' })
    c.setClipProperties('L', { linkGroupId: 'G1' })

    const f = structuredClone(c.getClip('F')!)
    const l = structuredClone(c.getClip('L')!)
    // Pair pasted together: keeps a shared NEW group id.
    const pairIds = c.insertClips([
      { clip: f, trackId: v1, startFrame: 100 },
      { clip: l, trackId: v2, startFrame: 100 }
    ])
    const [pf, pl] = pairIds.map((id) => c.getClip(id)!)
    expect(pf.linkGroupId).toBeTruthy()
    expect(pf.linkGroupId).toBe(pl.linkGroupId)
    expect(pf.linkGroupId).not.toBe('G1')
    // Singleton: link dropped entirely.
    const [soloId] = c.insertClips([{ clip: f, trackId: v1, startFrame: 300 }])
    expect(c.getClip(soloId)!.linkGroupId).toBeUndefined()
  })

  it('skips missing and type-incompatible tracks', () => {
    const { c, v1, a1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 30, id: 'A' })
    const a = structuredClone(c.getClip('A')!)
    const ids = c.insertClips([
      { clip: a, trackId: 'ghost', startFrame: 0 },
      { clip: a, trackId: a1, startFrame: 0 }, // video clip onto audio track
      { clip: a, trackId: v1, startFrame: 100 }
    ])
    expect(ids).toHaveLength(1)
    expect(c.getClip(ids[0])!.startFrame).toBe(100)
  })

  it('duplicateClips lands the block right after its end, preserving multicam relative layout', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'f', startFrame: 30, durationFrames: 60, id: 'F' })
    c.addClip({ trackId: v2, mediaRef: 'l', startFrame: 60, durationFrames: 90, id: 'L' })
    c.reset(c.getTimeline()) // clear setup history so the one-step assertion sees only the duplicate
    const ids = c.duplicateClips(['F', 'L'])
    expect(ids).toHaveLength(2)
    // Block is [30, 150) → offset 120. F' at 150, L' at 180.
    const dupF = c.getClip(ids[0])!
    const dupL = c.getClip(ids[1])!
    expect(dupF.startFrame).toBe(150)
    expect(dupL.startFrame).toBe(180)
    expect(c.getTrackOfClip(ids[0])!.id).toBe(v1)
    expect(c.getTrackOfClip(ids[1])!.id).toBe(v2)
    c.undo()
    expect(c.getClip(ids[0])).toBeNull()
    expect(c.canUndo()).toBe(false) // duplicate was one step
  })
})

describe('EditorController — undo coalescing (slider gestures)', () => {
  it('merges same-key edits into one undo step that restores the ORIGINAL value', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 60, id: 'A' })
    c.reset(c.getTimeline())
    c.setClipProperties('A', { opacity: 0.8 }, 'Opacidad', 'gesture-1')
    c.setClipProperties('A', { opacity: 0.5 }, 'Opacidad', 'gesture-1')
    c.setClipProperties('A', { opacity: 0.2 }, 'Opacidad', 'gesture-1')
    expect(c.getClip('A')!.opacity).toBe(0.2)
    expect(c.undo()).toBe(true)
    expect(c.getClip('A')!.opacity).toBe(1) // original, not 0.5
    expect(c.canUndo()).toBe(false)
    // Redo replays the whole gesture to its final value.
    expect(c.redo()).toBe(true)
    expect(c.getClip('A')!.opacity).toBe(0.2)
  })

  it('different keys create separate steps; keyless edits never merge', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 60, id: 'A' })
    c.reset(c.getTimeline())
    c.setClipProperties('A', { opacity: 0.8 }, 'Opacidad', 'g1')
    c.setClipProperties('A', { opacity: 0.5 }, 'Opacidad', 'g2')
    c.setClipProperties('A', { volume: 0.5 })
    c.undo()
    expect(c.getClip('A')!.volume).toBe(1)
    c.undo()
    expect(c.getClip('A')!.opacity).toBe(0.8)
    c.undo()
    expect(c.getClip('A')!.opacity).toBe(1)
  })

  it('coalesces setClipSpeed gestures too', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 60, id: 'A' })
    c.reset(c.getTimeline())
    c.setClipSpeed('A', 1.5, 'sg')
    c.setClipSpeed('A', 2, 'sg')
    expect(c.getClip('A')!.durationFrames).toBe(30)
    c.undo()
    expect(c.getClip('A')!.speed).toBe(1)
    expect(c.getClip('A')!.durationFrames).toBe(60)
    expect(c.canUndo()).toBe(false)
  })
})

describe('EditorController — keyframes', () => {
  it('upserts keyframes sorted, replaces same-frame, and samples the ramp', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.setClipKeyframe('A', 'opacity', 60, 0.2, 'linear')
    c.setClipKeyframe('A', 'opacity', 0, 1, 'linear')
    c.setClipKeyframe('A', 'opacity', 60, 0.5, 'linear') // replace
    const track = c.getClip('A')!.opacityTrack!
    expect(track.keyframes.map((k) => k.frame)).toEqual([0, 60])
    expect(track.keyframes[1].value).toBe(0.5)
    // sampleTrack semantics live in the model; opacityAt uses clip-relative frames.
    // Halfway (frame 30) on a linear 1→0.5 ramp = 0.75.
    expect(opacityAt(c.getClip('A')!, 30)).toBeCloseTo(0.75, 5)
  })

  it('clamps the frame to the clip duration and is one undo step per call', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.reset(c.getTimeline())
    c.setClipKeyframe('A', 'volume', 500, -6)
    const track = c.getClip('A')!.volumeTrack!
    expect(track.keyframes[0].frame).toBe(50) // clamped
    expect(c.undo()).toBe(true)
    expect(c.getClip('A')!.volumeTrack).toBeUndefined()
    expect(c.canUndo()).toBe(false)
  })

  it('removeClipKeyframe drops the exact frame and deletes an emptied track', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.setClipKeyframe('A', 'rotation', 0, 0)
    c.setClipKeyframe('A', 'rotation', 50, 90)
    c.removeClipKeyframe('A', 'rotation', 50)
    expect(c.getClip('A')!.rotationTrack!.keyframes.map((k) => k.frame)).toEqual([0])
    c.removeClipKeyframe('A', 'rotation', 0)
    expect(c.getClip('A')!.rotationTrack).toBeUndefined()
  })

  it('clearClipKeyframes removes the whole track for one property only', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: 'A' })
    c.setClipKeyframe('A', 'position', 0, { a: 0, b: 0 })
    c.setClipKeyframe('A', 'position', 50, { a: 0.5, b: 0.25 })
    c.setClipKeyframe('A', 'opacity', 0, 1)
    c.clearClipKeyframes('A', 'position')
    expect(c.getClip('A')!.positionTrack).toBeUndefined()
    expect(c.getClip('A')!.opacityTrack).toBeDefined()
  })
})

describe('EditorController — rippleDeleteRange', () => {
  it('splits boundaries, removes the range, and closes the gap (one undo step)', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 300, id: 'A' })
    c.reset(c.getTimeline())
    const r = c.rippleDeleteRange([v1], 100, 200)
    expect(r.ok).toBe(true)
    expect(r.removedFrames).toBe(100)
    const clips = clipsOf(c.getTimeline(), v1)
    expect(clips).toHaveLength(2)
    expect(clips[0].startFrame).toBe(0)
    expect(clipEndFrame(clips[0])).toBe(100)
    expect(clips[1].startFrame).toBe(100) // gap closed
    expect(clipEndFrame(clips[1])).toBe(200)
    expect(c.undo()).toBe(true)
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1)
    expect(c.canUndo()).toBe(false)
  })

  it('spans clip boundaries across the default (all) tracks', () => {
    const { c, v1, v2 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'a', startFrame: 0, durationFrames: 150, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'b', startFrame: 150, durationFrames: 150, id: 'B' })
    c.addClip({ trackId: v2, mediaRef: 'c', startFrame: 50, durationFrames: 100, id: 'C' })
    const r = c.rippleDeleteRange(undefined, 100, 200)
    expect(r.ok).toBe(true)
    // v1: [0,100) kept + [200,300) shifted to 100.
    const t1 = clipsOf(c.getTimeline(), v1)
    expect(t1.map((cl) => [cl.startFrame, clipEndFrame(cl)])).toEqual([
      [0, 100],
      [100, 200]
    ])
    // v2: clip C [50,150) loses its tail beyond 100.
    const t2 = clipsOf(c.getTimeline(), v2)
    expect(t2.map((cl) => [cl.startFrame, clipEndFrame(cl)])).toEqual([[50, 100]])
  })

  it('refuses without mutating when a sync-locked follower cannot absorb the shift', () => {
    const { c, v1, a1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'v', startFrame: 100, durationFrames: 200, id: 'V' })
    // Sync-locked audio: S2 would shift left 100 into [100,200), colliding with S1 [50,150).
    c.setTrackSyncLocked(a1, true)
    c.addClip({ trackId: a1, mediaRef: 's1', startFrame: 50, durationFrames: 100, mediaType: 'audio', id: 'S1' })
    c.addClip({ trackId: a1, mediaRef: 's2', startFrame: 200, durationFrames: 100, mediaType: 'audio', id: 'S2' })
    c.reset(c.getTimeline())
    const r = c.rippleDeleteRange([v1], 100, 200)
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
    expect(clipsOf(c.getTimeline(), v1)).toHaveLength(1) // no phantom splits
    expect(c.getClip('V')!.durationFrames).toBe(200)
    expect(c.canUndo()).toBe(false)
  })

  it('reports an empty or clip-less range without touching history', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'm', startFrame: 0, durationFrames: 50, id: 'A' })
    c.reset(c.getTimeline())
    expect(c.rippleDeleteRange([v1], 200, 100).ok).toBe(false)
    expect(c.rippleDeleteRange([v1], 100, 200).ok).toBe(false) // nothing there
    expect(c.canUndo()).toBe(false)
  })
})

describe('EditorController — closeGaps (compactar timeline)', () => {
  it('closes internal gaps on one track, making clips contiguous', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'a', startFrame: 0, durationFrames: 60, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'b', startFrame: 150, durationFrames: 60, id: 'B' }) // gap [60,150)
    c.addClip({ trackId: v1, mediaRef: 'd', startFrame: 300, durationFrames: 60, id: 'D' }) // gap [210,300)
    c.reset(c.getTimeline())
    const r = c.closeGaps()
    expect(r.ok).toBe(true)
    expect(r.removedFrames).toBe(90 + 90)
    const clips = clipsOf(c.getTimeline(), v1)
    expect(clips.map((cl) => [cl.id, cl.startFrame, clipEndFrame(cl)])).toEqual([
      ['A', 0, 60],
      ['B', 60, 120],
      ['D', 120, 180]
    ])
    expect(c.undo()).toBe(true) // one step
    expect(clipsOf(c.getTimeline(), v1).map((cl) => cl.startFrame)).toEqual([0, 150, 300])
    expect(c.canUndo()).toBe(false)
  })

  it('pulls the first clip to frame 0 (leading gap)', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'a', startFrame: 90, durationFrames: 60, id: 'A' })
    c.reset(c.getTimeline())
    const r = c.closeGaps()
    expect(r.ok).toBe(true)
    expect(r.removedFrames).toBe(90)
    expect(c.getClip('A')!.startFrame).toBe(0)
  })

  it('is sync-preserving: only closes columns empty across ALL tracks, keeping alignment', () => {
    const { c, v1, a1 } = seeded()
    // Video: [0,60), [150,210). Aligned audio: [0,60), [150,210). Gap [60,150) is empty on BOTH.
    c.addClip({ trackId: v1, mediaRef: 'v1', startFrame: 0, durationFrames: 60, id: 'V1' })
    c.addClip({ trackId: v1, mediaRef: 'v2', startFrame: 150, durationFrames: 60, id: 'V2' })
    c.addClip({ trackId: a1, mediaRef: 'a1', mediaType: 'audio', startFrame: 0, durationFrames: 60, id: 'A1' })
    c.addClip({ trackId: a1, mediaRef: 'a2', mediaType: 'audio', startFrame: 150, durationFrames: 60, id: 'A2' })
    c.reset(c.getTimeline())
    const r = c.closeGaps()
    expect(r.ok).toBe(true)
    expect(r.removedFrames).toBe(90) // the single shared gap, counted ONCE
    // Both tracks shift identically → V2 and A2 stay aligned at 60.
    expect(c.getClip('V2')!.startFrame).toBe(60)
    expect(c.getClip('A2')!.startFrame).toBe(60)
    expect(c.getClip('V1')!.startFrame).toBe(0)
    expect(c.getClip('A1')!.startFrame).toBe(0)
  })

  it('does NOT close a video gap that another track covers (would desync)', () => {
    const { c, v1, a1 } = seeded()
    // Video gap [60,150); a music clip on the audio track plays THROUGH it → not empty across all tracks.
    c.addClip({ trackId: v1, mediaRef: 'v1', startFrame: 0, durationFrames: 60, id: 'V1' })
    c.addClip({ trackId: v1, mediaRef: 'v2', startFrame: 150, durationFrames: 60, id: 'V2' })
    c.addClip({ trackId: a1, mediaRef: 'music', mediaType: 'audio', startFrame: 0, durationFrames: 210, id: 'MUS' })
    c.reset(c.getTimeline())
    const r = c.closeGaps()
    expect(r.ok).toBe(false) // no column is empty across ALL tracks
    expect(c.getClip('V2')!.startFrame).toBe(150) // untouched
    expect(c.canUndo()).toBe(false)
  })

  it('reports no gaps when the timeline is already contiguous, without mutating', () => {
    const { c, v1 } = seeded()
    c.addClip({ trackId: v1, mediaRef: 'a', startFrame: 0, durationFrames: 60, id: 'A' })
    c.addClip({ trackId: v1, mediaRef: 'b', startFrame: 60, durationFrames: 60, id: 'B' })
    c.reset(c.getTimeline())
    expect(c.closeGaps().ok).toBe(false)
    expect(c.canUndo()).toBe(false)
  })

  it('reports nothing to compact on an empty timeline', () => {
    const { c } = seeded()
    expect(c.closeGaps().ok).toBe(false)
  })
})
