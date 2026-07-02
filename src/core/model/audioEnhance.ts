// SPDX-License-Identifier: GPL-3.0-or-later
// Voice-cleanup / loudness settings for the "Realzar audio" inspector. Plain JSON so it persists for
// free (stored on the clip, like `color`) and is node-testable. The FFmpeg mapping (the exact filter
// chain used by export + the modal A/B) lives in ./audioEnhanceChain.ts; the live-preview approximation
// (Web Audio nodes) lives in renderer/audio/audioGraph.ts. This module only describes the knobs + their
// neutral defaults + the named presets, mirroring model/color.ts.
//
// Pipeline order (matches the chain builder): noise gate → high-pass → low-pass → spectral denoise →
// parametric EQ (low-shelf, mud cut, presence, air) → de-esser → compressor → limiter → loudness
// normalization → output gain.

export interface AudioEnhanceSettings {
  /** Master switch. When false the clip plays/exports raw (treated as identity). */
  enabled: boolean

  // --- Ruido ---
  /** Noise gate: silence everything below the threshold (kills room tone between phrases). */
  gate: boolean
  /** Gate threshold in dB. Quieter than this is attenuated. (-80..-20) */
  gateThresholdDb: number
  /** Spectral denoise (afftdn). */
  denoise: boolean
  /** Denoise strength (afftdn `nr`, dB). Only used when `denoise` is true. (0..40) */
  denoiseAmount: number

  // --- EQ ---
  /** High-pass cutoff in Hz to remove rumble. 0 disables. (0..200) */
  highpassHz: number
  /** Low-pass cutoff in Hz to tame hiss/harshness. 0 disables. (0 | 6000..20000) */
  lowpassHz: number
  /** Low-shelf gain in dB around 120 Hz (warmth/body). (-12..12) */
  lowShelfDb: number
  /** Peaking cut around 250 Hz in dB (removes "muddy"/boxy tone). (-12..0) */
  mudDb: number
  /** Peaking gain around 4 kHz in dB (speech presence/intelligibility). (-6..12) */
  presenceDb: number
  /** High-shelf gain in dB around 12 kHz ("air"/brightness). (-6..12) */
  airDb: number

  // --- De-esser ---
  /** Tame harsh sibilance ("s"/"sh"). */
  deEss: boolean
  /** De-ess intensity. (0..1) */
  deEssAmount: number

  // --- Dinámica ---
  /** Compressor threshold in dB (acompressor). (-40..0) */
  compThreshold: number
  /** Compressor ratio (acompressor). 1 = no compression. (1..10) */
  compRatio: number
  /** Compressor attack in ms. (1..100) */
  compAttack: number
  /** Compressor release in ms. (20..1000) */
  compRelease: number
  /** Make-up gain after compression, in dB. (0..12) */
  compMakeupDb: number
  /** Brick-wall limiter to catch peaks. */
  limiter: boolean
  /** Limiter ceiling in dB (true-peak target). (-3..0) */
  limitDb: number

  // --- Loudness / salida ---
  /** Integrated loudness target in LUFS. -16 ≈ talking-head/social, -14 louder, -9 very loud. (-24..-9) */
  targetLufs: number
  /** Final output trim in dB applied after loudness normalization. (-12..12) */
  outputGainDb: number
}

export const DEFAULT_AUDIO_ENHANCE: AudioEnhanceSettings = {
  enabled: true,
  gate: false,
  gateThresholdDb: -45,
  denoise: true,
  denoiseAmount: 12,
  highpassHz: 90,
  lowpassHz: 0,
  lowShelfDb: 0,
  mudDb: 0,
  presenceDb: 2,
  airDb: 0,
  deEss: false,
  deEssAmount: 0.5,
  compThreshold: -20,
  compRatio: 3,
  compAttack: 10,
  compRelease: 120,
  compMakeupDb: 4,
  limiter: true,
  limitDb: -1,
  targetLufs: -16,
  outputGainDb: 0
}

export function makeAudioEnhance(p: Partial<AudioEnhanceSettings> = {}): AudioEnhanceSettings {
  return {
    enabled: p.enabled ?? DEFAULT_AUDIO_ENHANCE.enabled,
    gate: p.gate ?? DEFAULT_AUDIO_ENHANCE.gate,
    gateThresholdDb: p.gateThresholdDb ?? DEFAULT_AUDIO_ENHANCE.gateThresholdDb,
    denoise: p.denoise ?? DEFAULT_AUDIO_ENHANCE.denoise,
    denoiseAmount: p.denoiseAmount ?? DEFAULT_AUDIO_ENHANCE.denoiseAmount,
    highpassHz: p.highpassHz ?? DEFAULT_AUDIO_ENHANCE.highpassHz,
    lowpassHz: p.lowpassHz ?? DEFAULT_AUDIO_ENHANCE.lowpassHz,
    lowShelfDb: p.lowShelfDb ?? DEFAULT_AUDIO_ENHANCE.lowShelfDb,
    mudDb: p.mudDb ?? DEFAULT_AUDIO_ENHANCE.mudDb,
    presenceDb: p.presenceDb ?? DEFAULT_AUDIO_ENHANCE.presenceDb,
    airDb: p.airDb ?? DEFAULT_AUDIO_ENHANCE.airDb,
    deEss: p.deEss ?? DEFAULT_AUDIO_ENHANCE.deEss,
    deEssAmount: p.deEssAmount ?? DEFAULT_AUDIO_ENHANCE.deEssAmount,
    compThreshold: p.compThreshold ?? DEFAULT_AUDIO_ENHANCE.compThreshold,
    compRatio: p.compRatio ?? DEFAULT_AUDIO_ENHANCE.compRatio,
    compAttack: p.compAttack ?? DEFAULT_AUDIO_ENHANCE.compAttack,
    compRelease: p.compRelease ?? DEFAULT_AUDIO_ENHANCE.compRelease,
    compMakeupDb: p.compMakeupDb ?? DEFAULT_AUDIO_ENHANCE.compMakeupDb,
    limiter: p.limiter ?? DEFAULT_AUDIO_ENHANCE.limiter,
    limitDb: p.limitDb ?? DEFAULT_AUDIO_ENHANCE.limitDb,
    targetLufs: p.targetLufs ?? DEFAULT_AUDIO_ENHANCE.targetLufs,
    outputGainDb: p.outputGainDb ?? DEFAULT_AUDIO_ENHANCE.outputGainDb
  }
}

/** Merge a partial patch onto a base so editing one slider doesn't reset the others. */
export function mergeAudioEnhance(
  base: AudioEnhanceSettings,
  patch: Partial<AudioEnhanceSettings>
): AudioEnhanceSettings {
  return { ...base, ...patch }
}

/** True when the settings should produce no processing (disabled). Mirrors `colorIsIdentity`: callers
 *  (export graph / live preview) skip the chain entirely so a disabled clip is byte-identical to raw. */
export function audioEnhanceIsIdentity(s: AudioEnhanceSettings | undefined | null): boolean {
  return !s || !s.enabled
}

export interface AudioEnhancePreset {
  id: string
  name: string
  settings: AudioEnhanceSettings
}

/** Recommended starting points shown as buttons in the audio inspector (parallel to DOCUMENT_PRESETS). */
export const AUDIO_PRESETS: AudioEnhancePreset[] = [
  {
    id: 'voz',
    name: 'Voz',
    settings: makeAudioEnhance({
      highpassHz: 90,
      denoise: true,
      denoiseAmount: 12,
      mudDb: -2,
      presenceDb: 3,
      airDb: 2,
      deEss: true,
      deEssAmount: 0.4,
      compThreshold: -20,
      compRatio: 3,
      compMakeupDb: 4,
      limiter: true,
      limitDb: -1,
      targetLufs: -16
    })
  },
  {
    id: 'podcast',
    name: 'Podcast',
    settings: makeAudioEnhance({
      gate: true,
      gateThresholdDb: -42,
      highpassHz: 80,
      denoise: true,
      denoiseAmount: 18,
      lowShelfDb: 1,
      mudDb: -3,
      presenceDb: 4,
      airDb: 3,
      deEss: true,
      deEssAmount: 0.5,
      compThreshold: -18,
      compRatio: 4,
      compMakeupDb: 5,
      limiter: true,
      limitDb: -1,
      targetLufs: -16
    })
  },
  {
    id: 'musica',
    name: 'Música',
    settings: makeAudioEnhance({
      highpassHz: 30,
      denoise: false,
      denoiseAmount: 0,
      presenceDb: 0,
      deEss: false,
      compThreshold: -24,
      compRatio: 2,
      compMakeupDb: 2,
      limiter: true,
      limitDb: -1,
      targetLufs: -14
    })
  }
]
