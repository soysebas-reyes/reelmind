// SPDX-License-Identifier: GPL-3.0-or-later
// Pure intensity-peak detection + cut-candidate fusion used by the angle-cut preview.

import { describe, expect, it } from 'vitest'
import {
  detectIntensityPeaks,
  detectPausesFromEnvelope,
  downsampleEnvelope,
  mergeCutCandidates,
  smoothEnvelope
} from './peaks'

describe('smoothEnvelope', () => {
  it('is a no-op for window ≤ 1', () => {
    const e = new Float32Array([0, 1, 0, 1])
    expect(smoothEnvelope(e, 1)).toBe(e)
  })

  it('averages a lone spike down toward its neighbors', () => {
    const e = new Float32Array([0, 0, 10, 0, 0])
    const s = smoothEnvelope(e, 3)
    expect(s[2]).toBeCloseTo(10 / 3, 5) // (0+10+0)/3
    expect(s[2]).toBeLessThan(e[2])
  })
})

describe('detectIntensityPeaks', () => {
  it('finds clear emphasis peaks and reports their time in seconds', () => {
    // 10 s at 10 Hz: two strong bumps at ~3 s and ~7 s over a quiet floor.
    const rate = 10
    const env = new Float32Array(100)
    for (let i = 0; i < env.length; i++) env[i] = 0.05
    env[30] = 1.0
    env[70] = 0.9
    const peaks = detectIntensityPeaks(env, { rate, minGapSeconds: 1, thresholdK: 1, smoothSeconds: 0.1 })
    expect(peaks.length).toBe(2)
    expect(peaks[0]).toBeCloseTo(3, 1)
    expect(peaks[1]).toBeCloseTo(7, 1)
  })

  it('keeps only the strongest peak within the min-gap window', () => {
    const rate = 10
    const env = new Float32Array(100)
    for (let i = 0; i < env.length; i++) env[i] = 0.05
    env[30] = 0.6
    env[33] = 1.0 // 0.3 s later, stronger — within a 1 s gap
    const peaks = detectIntensityPeaks(env, { rate, minGapSeconds: 1, thresholdK: 1, smoothSeconds: 0 })
    expect(peaks).toHaveLength(1)
    expect(peaks[0]).toBeCloseTo(3.3, 1)
  })

  it('returns nothing for a flat (no-emphasis) envelope', () => {
    const env = new Float32Array(50).fill(0.3)
    expect(detectIntensityPeaks(env, { rate: 10 })).toEqual([])
  })
})

describe('detectPausesFromEnvelope', () => {
  // 10 s at 10 Hz: loud speech, a clear ~1 s quiet gap centered at 5 s, then loud again.
  const loudQuietLoud = (scale = 1): Float32Array => {
    const rate = 10
    const env = new Float32Array(100)
    for (let i = 0; i < env.length; i++) env[i] = (i >= 45 && i < 55 ? 0.02 : 1.0) * scale
    return env
  }

  it('finds the midpoint of a sustained quiet run', () => {
    const pauses = detectPausesFromEnvelope(loudQuietLoud(), { rate: 10, minDurationSeconds: 0.5, smoothSeconds: 0 })
    expect(pauses).toHaveLength(1)
    expect(pauses[0]).toBeCloseTo(5, 0)
  })

  it('is level-independent: a uniformly quieter copy yields the SAME midpoints', () => {
    const loud = detectPausesFromEnvelope(loudQuietLoud(1), { rate: 10, minDurationSeconds: 0.5, smoothSeconds: 0 })
    const quiet = detectPausesFromEnvelope(loudQuietLoud(0.02), { rate: 10, minDurationSeconds: 0.5, smoothSeconds: 0 })
    expect(quiet).toEqual(loud)
  })

  it('ignores dips shorter than minDuration', () => {
    const rate = 10
    const env = new Float32Array(100).fill(1)
    env[50] = 0.01 // a single 0.1 s dip
    expect(detectPausesFromEnvelope(env, { rate, minDurationSeconds: 0.5, smoothSeconds: 0 })).toEqual([])
  })

  it('returns nothing for steady speech (no quiet run below the floor)', () => {
    const env = new Float32Array(100).fill(0.8)
    expect(detectPausesFromEnvelope(env, { rate: 10 })).toEqual([])
  })
})

describe('mergeCutCandidates', () => {
  it('sorts and drops candidates closer than the min gap', () => {
    const merged = mergeCutCandidates([5, 0.2, 0.3, 2, 2.4], 1)
    expect(merged).toEqual([0.2, 2, 5]) // 0.3 (<1 from 0.2) and 2.4 (<1 from 2) dropped
  })

  it('ignores negative / non-finite times', () => {
    expect(mergeCutCandidates([-1, NaN, 1, Infinity], 0.5)).toEqual([1])
  })
})

describe('downsampleEnvelope', () => {
  it('returns the normalized envelope unchanged when already short', () => {
    const out = downsampleEnvelope(new Float32Array([0, 2, 1]), 8)
    expect(out).toEqual([0, 1, 0.5]) // normalized by max=2
  })

  it('max-pools to the target length so peaks survive', () => {
    const env = new Float32Array(100)
    env[42] = 5 // a single spike
    const out = downsampleEnvelope(env, 10)
    expect(out).toHaveLength(10)
    expect(Math.max(...out)).toBe(1) // the spike bucket normalizes to 1
  })
})
