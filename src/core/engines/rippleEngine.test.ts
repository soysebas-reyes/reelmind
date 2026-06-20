// SPDX-License-Identifier: GPL-3.0-or-later
// Golden tests ported from palmier-pro Tests/.../Timeline/RippleEngineTests.swift

import { describe, expect, it } from 'vitest'
import { fxClip } from '../testing/fixtures'
import { type FrameRange, computeRippleShifts, computeRippleShiftsForRanges, computeRipplePush } from './rippleEngine'

const range = (start: number, end: number): FrameRange => ({ start, end })

describe('RippleEngine.computeRippleShifts', () => {
  it('empty removedIds produces no shifts', () => {
    const a = fxClip({ id: 'a', start: 0, duration: 50 })
    const b = fxClip({ id: 'b', start: 100, duration: 50 })
    expect(computeRippleShifts([a, b], new Set())).toEqual([])
  })

  it('removing middle clip shifts trailing clips left', () => {
    const removed = fxClip({ id: 'r', start: 50, duration: 50 })
    const trailing = fxClip({ id: 't', start: 200, duration: 50 })
    const head = fxClip({ id: 'h', start: 0, duration: 50 })
    const shifts = computeRippleShifts([head, removed, trailing], new Set(['r']))
    expect(shifts).toEqual([{ clipId: 't', newStartFrame: 150 }])
  })

  it('clips before removed range do not shift', () => {
    const head = fxClip({ id: 'h', start: 0, duration: 50 })
    const removed = fxClip({ id: 'r', start: 100, duration: 50 })
    expect(computeRippleShifts([head, removed], new Set(['r']))).toEqual([])
  })

  it('removing multiple clips shifts by merged total', () => {
    const r1 = fxClip({ id: 'r1', start: 0, duration: 50 })
    const r2 = fxClip({ id: 'r2', start: 100, duration: 50 })
    const tail = fxClip({ id: 't', start: 200, duration: 50 })
    const shifts = computeRippleShifts([r1, r2, tail], new Set(['r1', 'r2']))
    expect(shifts).toEqual([{ clipId: 't', newStartFrame: 100 }])
  })
})

describe('RippleEngine.computeRippleShiftsForRanges', () => {
  it('overlapping ranges merge before shifting', () => {
    const clip = fxClip({ id: 'c', start: 300, duration: 100 })
    const shifts = computeRippleShiftsForRanges([clip], [range(0, 100), range(50, 200)])
    expect(shifts).toEqual([{ clipId: 'c', newStartFrame: 100 }])
  })

  it('touching ranges merge before shifting', () => {
    const clip = fxClip({ id: 'c', start: 200, duration: 50 })
    const shifts = computeRippleShiftsForRanges([clip], [range(0, 50), range(50, 100)])
    expect(shifts).toEqual([{ clipId: 'c', newStartFrame: 100 }])
  })

  it('range wholly before clip shifts it; range after does not', () => {
    const a = fxClip({ id: 'a', start: 100, duration: 50 })
    const b = fxClip({ id: 'b', start: 200, duration: 50 })
    const shifts = computeRippleShiftsForRanges([a, b], [range(0, 50), range(400, 500)])
    expect(shifts).toEqual([
      { clipId: 'a', newStartFrame: 50 },
      { clipId: 'b', newStartFrame: 150 }
    ])
  })

  it('range must end at or before clip start to shift', () => {
    const clip = fxClip({ id: 'c', start: 100, duration: 50 })
    expect(computeRippleShiftsForRanges([clip], [range(0, 100)])).toEqual([{ clipId: 'c', newStartFrame: 0 }])
    expect(computeRippleShiftsForRanges([clip], [range(0, 101)])).toEqual([])
  })
})

describe('RippleEngine.computeRipplePush', () => {
  it('push moves clips at or after insertFrame', () => {
    const a = fxClip({ id: 'a', start: 0, duration: 50 })
    const b = fxClip({ id: 'b', start: 100, duration: 50 })
    const c = fxClip({ id: 'c', start: 200, duration: 50 })
    const shifts = computeRipplePush([a, b, c], 100, 30)
    expect(shifts).toEqual([
      { clipId: 'b', newStartFrame: 130 },
      { clipId: 'c', newStartFrame: 230 }
    ])
  })

  it('push skips excluded ids', () => {
    const a = fxClip({ id: 'a', start: 100, duration: 50 })
    const b = fxClip({ id: 'b', start: 200, duration: 50 })
    const shifts = computeRipplePush([a, b], 0, 25, new Set(['a']))
    expect(shifts).toEqual([{ clipId: 'b', newStartFrame: 225 }])
  })
})

describe('RippleEngine — adversarial', () => {
  it('shifts preserve startFrame order', () => {
    const clips = [
      fxClip({ id: 'a', start: 0, duration: 50 }),
      fxClip({ id: 'b', start: 100, duration: 50 }),
      fxClip({ id: 'c', start: 200, duration: 50 }),
      fxClip({ id: 'd', start: 300, duration: 50 })
    ]
    const shifts = computeRippleShifts(clips, new Set(['b', 'c']))
    const newStarts = new Map(clips.filter((c) => !['b', 'c'].includes(c.id)).map((c) => [c.id, c.startFrame]))
    for (const s of shifts) newStarts.set(s.clipId, s.newStartFrame)
    const starts = [...newStarts.values()]
    expect(starts).toEqual([...starts].sort((x, y) => x - y))
  })

  it('push does not make clips collide', () => {
    const clips = [fxClip({ id: 'anchor', start: 0, duration: 50 }), fxClip({ id: 'follower', start: 100, duration: 50 })]
    const shifts = computeRipplePush(clips, 100, 30)
    const followerNewStart = shifts.find((s) => s.clipId === 'follower')?.newStartFrame
    expect(followerNewStart).toBe(130)
    expect(followerNewStart!).toBeGreaterThanOrEqual(50)
  })
})
