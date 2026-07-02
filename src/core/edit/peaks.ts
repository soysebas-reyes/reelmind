// SPDX-License-Identifier: GPL-3.0-or-later
// Pure intensity-peak detection over an RMS loudness envelope, used to propose *dynamic* angle-cut
// candidates (moments of vocal emphasis) alongside silence-based candidates. No IO, no framework —
// the main process feeds it an envelope from `rmsEnvelope` (see edit/audioSync). Mirrors the spirit
// of the standalone `analyze_videos.py` RMS analysis, reimplemented in JS so the app needs no Python.

export interface PeakOptions {
  /** Envelope sample rate (Hz) — points per second. */
  rate: number
  /** Minimum seconds between adjacent peaks (avoids over-cutting). Default 1.2. */
  minGapSeconds?: number
  /** Peak threshold expressed as (mean + k·std) of the smoothed envelope. Default 1.0. */
  thresholdK?: number
  /** Moving-average smoothing window in seconds. Default 0.15. */
  smoothSeconds?: number
}

/** Centered moving-average smoothing. `win` is the window length in samples (≤1 → no-op). */
export function smoothEnvelope(env: Float32Array, win: number): Float32Array {
  if (win <= 1 || env.length === 0) return env
  const n = env.length
  const half = Math.floor(win / 2)
  const out = new Float32Array(n)
  // Prefix sums → O(n) regardless of window size.
  const prefix = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i]
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n - 1, i + half)
    out[i] = (prefix[b + 1] - prefix[a]) / (b - a + 1)
  }
  return out
}

/** Local maxima of the smoothed envelope above (mean + k·std), kept ≥ minGap apart (strongest wins
 *  within a cluster). Returns peak times in seconds. */
export function detectIntensityPeaks(env: Float32Array, opts: PeakOptions): number[] {
  const n = env.length
  if (n < 3) return []
  const rate = opts.rate
  const sm = smoothEnvelope(env, Math.max(1, Math.round((opts.smoothSeconds ?? 0.15) * rate)))
  let mean = 0
  for (let i = 0; i < n; i++) mean += sm[i]
  mean /= n
  let varr = 0
  for (let i = 0; i < n; i++) {
    const d = sm[i] - mean
    varr += d * d
  }
  const std = Math.sqrt(varr / n)
  const thresh = mean + (opts.thresholdK ?? 1.0) * std
  const minGap = Math.max(1, Math.round((opts.minGapSeconds ?? 1.2) * rate))

  const peakIdx: number[] = []
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] <= thresh || sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue
    const last = peakIdx[peakIdx.length - 1]
    if (last === undefined || i - last >= minGap) {
      peakIdx.push(i)
    } else if (sm[i] > sm[last]) {
      peakIdx[peakIdx.length - 1] = i // keep the strongest peak within the gap
    }
  }
  return peakIdx.map((i) => i / rate)
}

export interface PauseOptions {
  /** Envelope sample rate (Hz) — points per second. */
  rate: number
  /** Minimum pause length to report, in seconds. Default 0.5. */
  minDurationSeconds?: number
  /** Moving-average smoothing window in seconds. Default 0.15. */
  smoothSeconds?: number
  /** Floor = `floorFraction · median(smoothed envelope)`. Default 0.5. */
  floorFraction?: number
}

/** Pause MIDPOINT times (seconds): contiguous runs where the smoothed envelope sits below a RELATIVE
 *  floor (a fraction of its own median) for ≥ minDuration. The median ignores the loud-speech tail, so
 *  the floor tracks the clip's own "quiet" level — level-independent, unlike an absolute dB threshold.
 *  This is the quiet-audio-safe replacement for FFmpeg `silencedetect=noise=-30dB`. */
export function detectPausesFromEnvelope(env: Float32Array, opts: PauseOptions): number[] {
  const n = env.length
  if (n < 3) return []
  const rate = opts.rate
  const sm = smoothEnvelope(env, Math.max(1, Math.round((opts.smoothSeconds ?? 0.15) * rate)))
  // Robust scale: median of the smoothed envelope (copy before sorting — don't mutate `sm`).
  const sorted = Float32Array.from(sm).sort()
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const floor = (opts.floorFraction ?? 0.5) * median
  const minLen = Math.max(1, Math.round((opts.minDurationSeconds ?? 0.5) * rate))

  const mids: number[] = []
  let runStart = -1
  for (let i = 0; i < n; i++) {
    const below = sm[i] <= floor
    if (below && runStart < 0) runStart = i
    if ((!below || i === n - 1) && runStart >= 0) {
      const runEnd = below ? i : i - 1
      if (runEnd - runStart + 1 >= minLen) mids.push((runStart + runEnd) / 2 / rate)
      runStart = -1
    }
  }
  return mids
}

/** Merge candidate cut times (seconds) into a sorted list, dropping any closer than `minGapSeconds`
 *  to the previously kept one. Use to fuse silence-midpoints and intensity peaks. */
export function mergeCutCandidates(times: number[], minGapSeconds: number): number[] {
  const sorted = times.filter((t) => Number.isFinite(t) && t >= 0).sort((a, b) => a - b)
  const out: number[] = []
  for (const t of sorted) {
    if (out.length === 0 || t - out[out.length - 1] >= minGapSeconds) out.push(t)
  }
  return out
}

/** Downsample an envelope to ~`targetLen` points by max-pooling (so peaks survive), normalized 0..1.
 *  For drawing a compact waveform in the preview. */
export function downsampleEnvelope(env: Float32Array, targetLen: number): number[] {
  const n = env.length
  if (n === 0 || targetLen <= 0) return []
  let max = 0
  for (let i = 0; i < n; i++) if (env[i] > max) max = env[i]
  const norm = max > 0 ? 1 / max : 1
  if (n <= targetLen) return Array.from(env, (v) => v * norm)
  const out = new Array<number>(targetLen)
  for (let k = 0; k < targetLen; k++) {
    const a = Math.floor((k * n) / targetLen)
    const b = Math.max(a + 1, Math.floor(((k + 1) * n) / targetLen))
    let m = 0
    for (let j = a; j < b && j < n; j++) if (env[j] > m) m = env[j]
    out[k] = m * norm
  }
  return out
}
