// SPDX-License-Identifier: GPL-3.0-or-later
// Audio-based multicam sync (pure DSP, no IO). Two cameras film the same take and may start at
// different times; we recover the time offset between their audio by cross-correlating short-time
// energy envelopes. No FFT and no dependency: the offset is physically bounded (same event), so a
// coarse→fine bounded direct cross-correlation is cheap and exact enough. The main process decodes
// low-rate mono PCM via ffmpeg and feeds it here (see src/main/ffmpeg/audioSync.ts).

export interface EnvelopeOptions {
  /** Sample rate (Hz) of the mono PCM the envelope is built from. Default 8000. */
  sampleRate?: number
  /** Hop length in seconds → one envelope sample per hop. Default 0.010 (→100 Hz envelope). */
  hopSeconds?: number
  /** log1p(RMS) compression so loud transients don't swamp speech across mismatched mic gains. */
  logCompress?: boolean
}

const DEFAULT_HOP_SECONDS = 0.01

/** Envelope sample rate (Hz) implied by the hop length. */
export function envelopeRate(opts: EnvelopeOptions = {}): number {
  return 1 / (opts.hopSeconds ?? DEFAULT_HOP_SECONDS)
}

/** Float32 mono PCM → short-time RMS energy envelope. Length = floor(pcm.length / samplesPerHop). */
export function rmsEnvelope(pcm: Float32Array, opts: EnvelopeOptions = {}): Float32Array {
  const sr = opts.sampleRate ?? 8000
  const hop = Math.max(1, Math.round(sr * (opts.hopSeconds ?? DEFAULT_HOP_SECONDS)))
  const logCompress = opts.logCompress ?? true
  const n = Math.floor(pcm.length / hop)
  const env = new Float32Array(n)
  for (let k = 0; k < n; k++) {
    let sum = 0
    const base = k * hop
    for (let i = 0; i < hop; i++) {
      const v = pcm[base + i]
      sum += v * v
    }
    const rms = Math.sqrt(sum / hop)
    env[k] = logCompress ? Math.log1p(rms) : rms
  }
  return env
}

export interface CrossCorrelateOptions {
  /** Envelope sample rate (Hz) — used to convert maxLag/minOverlap seconds to samples. Default 100. */
  envelopeRate?: number
  /** Max |offset| searched (s). The two cameras record the same event, so this is bounded. Default 300. */
  maxLagSeconds?: number
  /** Coarse-stage decimation factor. Default 10. */
  coarseFactor?: number
  /** Minimum overlap (s) for a lag to be eligible — guards against a tiny-overlap tail winning. Default 30. */
  minOverlapSeconds?: number
}

export interface CrossCorrelationResult {
  /** Lag of B relative to A, in envelope samples. Positive ⇒ B starts AFTER A (B recorded later). */
  lagSamples: number
  /** Peak normalized correlation, clamped to [0,1]. 0 ⇒ no usable correlation. */
  confidence: number
  /** Peak minus the best score outside the peak neighborhood — higher ⇒ a sharper, more trustworthy peak. */
  margin: number
}

/** UI/host warn thresholds: below either, treat the detected offset as unreliable. */
export const SYNC_MIN_CONFIDENCE = 0.5
export const SYNC_MIN_MARGIN = 0.1

/** Mean/std of a signal; std is 0 for empty or constant input (degenerate → no correlation). */
function stats(x: Float32Array): { mean: number; std: number } {
  if (x.length === 0) return { mean: 0, std: 0 }
  let mean = 0
  for (let i = 0; i < x.length; i++) mean += x[i]
  mean /= x.length
  let varSum = 0
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean
    varSum += d * d
  }
  return { mean, std: Math.sqrt(varSum / x.length) }
}

/** z-score (mean 0, std 1) so per-mic gain/DC differences don't bias the correlation. */
function zscore(x: Float32Array, mean: number, std: number): Float32Array {
  const out = new Float32Array(x.length)
  const inv = 1 / std
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - mean) * inv
  return out
}

/** Every `factor`-th sample (cheap decimation for the coarse search stage). */
function decimate(x: Float32Array, factor: number): Float32Array {
  if (factor <= 1) return x
  const n = Math.floor(x.length / factor)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = x[i * factor]
  return out
}

/** Overlap-normalized correlation of zA vs zB at integer `lag` (zB shifted so zA[i] ↔ zB[i-lag]). */
function scoreAt(zA: Float32Array, zB: Float32Array, lag: number, minOverlap: number): number {
  const iStart = Math.max(0, lag)
  const iEnd = Math.min(zA.length, zB.length + lag)
  const overlap = iEnd - iStart
  if (overlap < minOverlap) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (let i = iStart; i < iEnd; i++) sum += zA[i] * zB[i - lag]
  return sum / overlap
}

/** Best lag in [minLag, maxLag] plus the runner-up outside a small neighborhood (for the margin). */
function searchRange(
  zA: Float32Array,
  zB: Float32Array,
  minLag: number,
  maxLag: number,
  minOverlap: number,
  neighborhood: number
): { lag: number; score: number; second: number } {
  let bestLag = 0
  let bestScore = Number.NEGATIVE_INFINITY
  const scores: { lag: number; score: number }[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = scoreAt(zA, zB, lag, minOverlap)
    scores.push({ lag, score: s })
    if (s > bestScore) {
      bestScore = s
      bestLag = lag
    }
  }
  let second = Number.NEGATIVE_INFINITY
  for (const { lag, score } of scores) {
    if (Math.abs(lag - bestLag) <= neighborhood) continue
    if (score > second) second = score
  }
  return { lag: bestLag, score: bestScore, second }
}

/**
 * Bounded coarse→fine normalized cross-correlation of two energy envelopes (same rate).
 * Returns the lag of peak correlation (B vs A) with a confidence + margin. O(N·maxLag/coarse²) — for a
 * 10-min/100 Hz envelope this is tens of millions of MACs, sub-second, with two Float32Array allocs.
 */
export function crossCorrelateOffset(
  envA: Float32Array,
  envB: Float32Array,
  opts: CrossCorrelateOptions = {}
): CrossCorrelationResult {
  const fe = opts.envelopeRate ?? 100
  const coarse = Math.max(1, Math.round(opts.coarseFactor ?? 10))
  const maxLag = Math.max(1, Math.round((opts.maxLagSeconds ?? 300) * fe))
  const minOverlap = Math.max(1, Math.round((opts.minOverlapSeconds ?? 30) * fe))

  const sa = stats(envA)
  const sb = stats(envB)
  if (sa.std === 0 || sb.std === 0) return { lagSamples: 0, confidence: 0, margin: 0 }
  const zA = zscore(envA, sa.mean, sa.std)
  const zB = zscore(envB, sb.mean, sb.std)

  // Stage A — coarse search over the full ±maxLag on decimated envelopes.
  const cA = decimate(zA, coarse)
  const cB = decimate(zB, coarse)
  const coarseMaxLag = Math.max(1, Math.round(maxLag / coarse))
  const coarseMinOverlap = Math.max(1, Math.round(minOverlap / coarse))
  const coarseRes = searchRange(cA, cB, -coarseMaxLag, coarseMaxLag, coarseMinOverlap, 2)

  // Stage B — refine at full resolution within ±coarse around the coarse peak.
  const center = coarseRes.lag * coarse
  const lo = Math.max(-maxLag, center - coarse)
  const hi = Math.min(maxLag, center + coarse)
  const fineRes = searchRange(zA, zB, lo, hi, minOverlap, 0)

  const confidence = Math.min(1, Math.max(0, fineRes.score))
  const margin = Number.isFinite(coarseRes.second) ? coarseRes.score - coarseRes.second : coarseRes.score
  return { lagSamples: fineRes.lag, confidence, margin: Math.max(0, margin) }
}

/** Convert an envelope-sample lag to seconds. Positive ⇒ B is delayed relative to A. */
export function lagToSeconds(lagSamples: number, rate = 100): number {
  return lagSamples / rate
}
