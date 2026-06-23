// SPDX-License-Identifier: GPL-3.0-or-later
// Pure DSP tests for multicam audio sync: envelope shape, known-lag recovery (±), gain invariance,
// uncorrelated → low confidence, overlap handling, and degenerate inputs (no NaN).

import { describe, expect, it } from 'vitest'
import {
  SYNC_MIN_CONFIDENCE,
  crossCorrelateOffset,
  envelopeRate,
  lagToSeconds,
  rmsEnvelope
} from './audioSync'

/** Deterministic [0,1) PRNG (LCG) so tests are reproducible without Math.random. */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** A SMOOTH envelope of length n (box-filtered noise) — realistic for an audio energy envelope, which
 *  varies slowly relative to the 100 Hz rate, so it survives the coarse decimation stage. */
function makeEnv(seed: number, n: number): Float32Array {
  const r = prng(seed)
  const W = 8
  const raw = new Float32Array(n + W)
  for (let i = 0; i < raw.length; i++) raw[i] = r()
  const e = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let w = 0; w < W; w++) sum += raw[i + w]
    e[i] = sum / W
  }
  return e
}

// Small, snappy search window matched to the synthetic signal sizes.
const OPTS = { envelopeRate: 100, maxLagSeconds: 8, minOverlapSeconds: 5, coarseFactor: 4 }

describe('rmsEnvelope', () => {
  it('computes a flat non-zero envelope for a constant signal and correct length', () => {
    const pcm = new Float32Array(1000).fill(0.5)
    const env = rmsEnvelope(pcm, { sampleRate: 8000, hopSeconds: 0.01, logCompress: false })
    expect(env.length).toBe(12) // floor(1000 / 80)
    for (const v of env) expect(v).toBeCloseTo(0.5, 5)
  })

  it('is all-zero for silence', () => {
    const env = rmsEnvelope(new Float32Array(800), { sampleRate: 8000 })
    expect(env.length).toBe(10)
    expect(Array.from(env).every((v) => v === 0)).toBe(true)
  })

  it('envelopeRate is the inverse of the hop', () => {
    expect(envelopeRate({ hopSeconds: 0.01 })).toBe(100)
    expect(envelopeRate()).toBe(100)
  })
})

describe('crossCorrelateOffset', () => {
  it('recovers a positive lag (B started later than A)', () => {
    const N = 3000
    const K = 73
    const a = makeEnv(1, N)
    const b = a.slice(K) // B = A with its first K samples dropped → B lags A by K
    const r = crossCorrelateOffset(a, b, OPTS)
    expect(r.lagSamples).toBe(K)
    expect(r.confidence).toBeGreaterThan(0.9)
    expect(r.margin).toBeGreaterThan(0.3)
  })

  it('recovers a negative lag (B started earlier than A)', () => {
    const N = 3000
    const K = 61
    const base = makeEnv(2, N + K)
    const a = base.slice(K) // A starts K later than the base → A lags B
    const b = base.slice(0, N) // B is the base start → B leads A by K
    const r = crossCorrelateOffset(a, b, OPTS)
    expect(r.lagSamples).toBe(-K)
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  it('is invariant to per-mic gain (z-scoring)', () => {
    const N = 3000
    const K = 90
    const a = makeEnv(3, N)
    const b = a.slice(K).map((v) => v * 10) as Float32Array
    const r = crossCorrelateOffset(a, b, OPTS)
    expect(r.lagSamples).toBe(K)
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  it('reports low confidence for uncorrelated signals', () => {
    const a = makeEnv(10, 3000)
    const b = makeEnv(99, 3000) // independent noise
    const r = crossCorrelateOffset(a, b, OPTS)
    expect(r.confidence).toBeLessThan(SYNC_MIN_CONFIDENCE)
  })

  it('never selects a lag whose overlap is below the minimum', () => {
    const N = 3000
    const a = makeEnv(5, N)
    const b = a.slice(50)
    // minOverlapSeconds 5 @ 100 Hz = 500 samples; the recovered lag must keep ample overlap.
    const r = crossCorrelateOffset(a, b, OPTS)
    expect(Math.abs(r.lagSamples)).toBeLessThan(N - 500)
  })

  it('handles degenerate inputs without NaN', () => {
    const empty = crossCorrelateOffset(new Float32Array(0), new Float32Array(0), OPTS)
    expect(empty).toEqual({ lagSamples: 0, confidence: 0, margin: 0 })
    const constant = crossCorrelateOffset(new Float32Array(3000).fill(1), makeEnv(7, 3000), OPTS)
    expect(constant.confidence).toBe(0)
    expect(Number.isNaN(constant.confidence)).toBe(false)
  })
})

describe('lagToSeconds', () => {
  it('converts envelope samples to seconds at the envelope rate', () => {
    expect(lagToSeconds(150, 100)).toBeCloseTo(1.5, 6)
    expect(lagToSeconds(-50, 100)).toBeCloseTo(-0.5, 6)
  })
})
