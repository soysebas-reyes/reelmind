// SPDX-License-Identifier: GPL-3.0-or-later
// The EXACT FFmpeg `-af` chain for the audio-enhance settings. Pure string builder living in core so BOTH
// the export graph (core) and the main-process renders (modal A/B + optional bake) emit identical audio.
// Order matters: noise gate → high-pass → low-pass → spectral denoise → parametric EQ → de-esser →
// compressor → limiter → loudness normalization → output gain. Loudness is LAST (degrades gracefully on
// near-silent input). `enabled` is the caller's master switch — this builder always emits the full chain
// for whatever settings it's given.

import { type AudioEnhanceSettings, makeAudioEnhance } from './audioEnhance'

/** dB → linear amplitude (for filters whose params are linear gain, e.g. agate/alimiter/acompressor makeup). */
function lin(db: number): number {
  return Math.pow(10, db / 20)
}

/** Build the comma-joined `-af` chain from (partial) settings. */
export function buildEnhanceChain(p: Partial<AudioEnhanceSettings> = {}): string {
  const s = makeAudioEnhance(p)
  const parts: string[] = []

  // Noise gate (linear threshold).
  if (s.gate) parts.push(`agate=threshold=${lin(s.gateThresholdDb).toFixed(5)}:ratio=2:attack=5:release=80`)

  // Spectral cleanup / band-limiting.
  if (s.highpassHz > 0) parts.push(`highpass=f=${Math.round(s.highpassHz)}`)
  if (s.lowpassHz > 0) parts.push(`lowpass=f=${Math.round(s.lowpassHz)}`)
  if (s.denoise) parts.push(`afftdn=nr=${s.denoiseAmount}:nf=-25`)

  // Parametric EQ (gains in dB; skip neutral bands).
  if (s.lowShelfDb !== 0) parts.push(`equalizer=f=120:t=q:w=0.7:g=${s.lowShelfDb}`)
  if (s.mudDb !== 0) parts.push(`equalizer=f=250:t=q:w=1.2:g=${s.mudDb}`)
  if (s.presenceDb !== 0) parts.push(`equalizer=f=4000:t=q:w=1.0:g=${s.presenceDb}`)
  if (s.airDb !== 0) parts.push(`equalizer=f=12000:t=q:w=0.7:g=${s.airDb}`)

  // De-esser.
  if (s.deEss) parts.push(`deesser=i=${Math.max(0, Math.min(1, s.deEssAmount)).toFixed(2)}`)

  // Compression (threshold accepts a dB suffix; makeup is a linear multiplier ≥1).
  parts.push(
    `acompressor=threshold=${s.compThreshold}dB:ratio=${s.compRatio}:attack=${s.compAttack}:release=${s.compRelease}:makeup=${lin(Math.max(0, s.compMakeupDb)).toFixed(3)}`
  )

  // Brick-wall limiter (linear ceiling).
  if (s.limiter) parts.push(`alimiter=limit=${lin(s.limitDb).toFixed(5)}`)

  // Loudness normalization (LAST), then optional output trim.
  parts.push(`loudnorm=I=${s.targetLufs}:TP=-1.5:LRA=11`)
  if (s.outputGainDb !== 0) parts.push(`volume=${s.outputGainDb}dB`)

  return parts.join(',')
}
