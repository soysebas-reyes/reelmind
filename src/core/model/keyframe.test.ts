// SPDX-License-Identifier: GPL-3.0-or-later
// Golden tests ported from palmier-pro Tests/.../Timeline/KeyframeTests.swift

import { describe, expect, it } from 'vitest'
import {
  type AnimPair,
  type KeyframeTrack,
  emptyTrack,
  keyframe,
  kfMove,
  kfRemove,
  kfUpsert,
  lerpAnimPair,
  lerpNumber,
  sampleTrack,
  smoothstep,
  trackIsActive
} from './keyframe'
import { lerpCrop, makeCrop } from './timeline'

const sampleNum = (t: KeyframeTrack<number>, frame: number, fallback: number): number =>
  sampleTrack(t, frame, fallback, lerpNumber)

describe('KeyframeTrack mutations', () => {
  it('upsert into empty appends', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].frame).toBe(10)
    expect(trackIsActive(track)).toBe(true)
  })

  it('upsert maintains sorted order', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(20, 2.0))
    kfUpsert(track, keyframe(5, 0.5))
    kfUpsert(track, keyframe(10, 1.0))
    expect(track.keyframes.map((k) => k.frame)).toEqual([5, 10, 20])
  })

  it('upsert replaces keyframe at same frame', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    kfUpsert(track, keyframe(10, 99.0))
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].value).toBe(99.0)
  })

  it('remove deletes at frame', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(5, 0.5))
    kfUpsert(track, keyframe(10, 1.0))
    kfRemove(track, 5)
    expect(track.keyframes.map((k) => k.frame)).toEqual([10])
  })

  it('remove at missing frame is a no-op', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    kfRemove(track, 99)
    expect(track.keyframes).toHaveLength(1)
  })

  it('empty track is not active', () => {
    expect(trackIsActive(emptyTrack<number>())).toBe(false)
  })

  it('move relocates keyframe and maintains order', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(5, 0.5))
    kfUpsert(track, keyframe(10, 1.0))
    kfUpsert(track, keyframe(20, 2.0))
    kfMove(track, 5, 15)
    expect(track.keyframes.map((k) => k.frame)).toEqual([10, 15, 20])
    expect(track.keyframes[1].value).toBe(0.5)
  })

  it('move from missing frame is a no-op', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    kfMove(track, 99, 5)
    expect(track.keyframes.map((k) => k.frame)).toEqual([10])
  })

  it('move onto existing frame is refused', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(5, 0.5))
    kfUpsert(track, keyframe(10, 1.0))
    kfMove(track, 5, 10)
    expect(track.keyframes).toHaveLength(2)
    expect(track.keyframes.find((k) => k.frame === 5)?.value).toBe(0.5)
    expect(track.keyframes.find((k) => k.frame === 10)?.value).toBe(1.0)
  })

  it('move onto same frame is a no-op', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 0.5))
    kfMove(track, 10, 10)
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].value).toBe(0.5)
  })
})

describe('KeyframeTrack.sample', () => {
  it('empty track returns fallback', () => {
    expect(sampleNum(emptyTrack<number>(), 10, 42.0)).toBe(42.0)
  })

  it('single keyframe returns its value everywhere', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 7.0))
    expect(sampleNum(track, 0, 0)).toBe(7.0)
    expect(sampleNum(track, 10, 0)).toBe(7.0)
    expect(sampleNum(track, 100, 0)).toBe(7.0)
  })

  it('samples before first clamp to first value', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    kfUpsert(track, keyframe(20, 2.0))
    expect(sampleNum(track, 5, 0)).toBe(1.0)
    expect(sampleNum(track, 10, 0)).toBe(1.0)
  })

  it('samples after last clamp to last value', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(10, 1.0))
    kfUpsert(track, keyframe(20, 2.0))
    expect(sampleNum(track, 20, 0)).toBe(2.0)
    expect(sampleNum(track, 100, 0)).toBe(2.0)
  })

  it('linear interpolates between keyframes', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(0, 0, 'linear'))
    kfUpsert(track, keyframe(10, 10))
    expect(sampleNum(track, 3, 0)).toBe(3.0)
    expect(sampleNum(track, 5, 0)).toBe(5.0)
    expect(sampleNum(track, 7, 0)).toBe(7.0)
  })

  it('hold returns left keyframe until next starts', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(0, 0, 'hold'))
    kfUpsert(track, keyframe(10, 10))
    expect(sampleNum(track, 1, 0)).toBe(0.0)
    expect(sampleNum(track, 9, 0)).toBe(0.0)
    expect(sampleNum(track, 10, 0)).toBe(10.0)
  })

  it('smooth uses smoothstep easing', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(0, 0, 'smooth'))
    kfUpsert(track, keyframe(10, 10))
    expect(sampleNum(track, 5, 0)).toBe(5.0)
    const early = sampleNum(track, 1, 0)
    expect(early).toBeLessThan(1.0)
    expect(early).toBeGreaterThan(0)
  })

  it('interpolationOut belongs to the left keyframe', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(0, 0, 'linear'))
    kfUpsert(track, keyframe(10, 10, 'hold'))
    expect(sampleNum(track, 5, 0)).toBe(5.0)
  })
})

describe('Interpolation primitives', () => {
  it('smoothstep endpoints are zero and one', () => {
    expect(smoothstep(0)).toBe(0)
    expect(smoothstep(1)).toBe(1)
  })

  it('smoothstep midpoint is half', () => {
    expect(smoothstep(0.5)).toBe(0.5)
  })

  it('smoothstep flattens near edges', () => {
    expect(smoothstep(0.1)).toBeLessThan(0.1)
    expect(smoothstep(0.9)).toBeGreaterThan(0.9)
  })

  it('number interpolation is linear', () => {
    expect(lerpNumber(0, 10, 0.25)).toBe(2.5)
    expect(lerpNumber(-5, 5, 0.5)).toBe(0)
  })

  it('AnimPair interpolates both components independently', () => {
    const result: AnimPair = lerpAnimPair({ a: 0, b: 100 }, { a: 10, b: 200 }, 0.5)
    expect(result.a).toBe(5)
    expect(result.b).toBe(150)
  })

  it('Crop interpolates all four insets', () => {
    const result = lerpCrop(makeCrop(), makeCrop({ left: 1, top: 1, right: 1, bottom: 1 }), 0.25)
    expect(result.left).toBe(0.25)
    expect(result.top).toBe(0.25)
    expect(result.right).toBe(0.25)
    expect(result.bottom).toBe(0.25)
  })
})

describe('Keyframes — adversarial', () => {
  it('track stays sorted across scrambled upserts', () => {
    const track = emptyTrack<number>()
    for (const f of [50, 10, 90, 30, 70, 0, 40, 20, 80, 60]) kfUpsert(track, keyframe(f, f))
    const frames = track.keyframes.map((k) => k.frame)
    expect(frames).toEqual([...frames].sort((a, b) => a - b))
  })

  it('upsert collapses repeated same-frame writes (last wins)', () => {
    const track = emptyTrack<number>()
    for (const v of [1.0, 2.0, 3.0, 4.0]) kfUpsert(track, keyframe(10, v))
    expect(track.keyframes).toHaveLength(1)
    expect(track.keyframes[0].value).toBe(4.0)
  })

  it('smoothstep stays in unit interval for unit inputs', () => {
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const s = smoothstep(t)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })

  it('smoothstep is monotonically non-decreasing on unit interval', () => {
    let prev = smoothstep(0)
    for (let i = 1; i <= 100; i++) {
      const s = smoothstep(i / 100)
      expect(s).toBeGreaterThanOrEqual(prev)
      prev = s
    }
  })

  it('track accepts negative frames and stays sorted', () => {
    const track = emptyTrack<number>()
    kfUpsert(track, keyframe(-10, 0))
    kfUpsert(track, keyframe(10, 1))
    kfUpsert(track, keyframe(-5, 0.5))
    expect(track.keyframes.map((k) => k.frame)).toEqual([-10, -5, 10])
  })
})
