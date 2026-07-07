// SPDX-License-Identifier: GPL-3.0-or-later
// Audio-enhance model: neutral defaults, partial merge, and the named presets.

import { describe, expect, it } from 'vitest'
import {
  AUDIO_PRESETS,
  DEFAULT_AUDIO_ENHANCE,
  audioEnhanceIsIdentity,
  makeAudioEnhance,
  mergeAudioEnhance
} from './audioEnhance'
import { buildEnhanceChain } from './audioEnhanceChain'

describe('makeAudioEnhance', () => {
  it('defaults to the recommended voice settings', () => {
    expect(makeAudioEnhance()).toEqual(DEFAULT_AUDIO_ENHANCE)
  })

  it('keeps provided fields and fills the rest with defaults', () => {
    const a = makeAudioEnhance({ targetLufs: -14, denoise: false })
    expect(a.targetLufs).toBe(-14)
    expect(a.denoise).toBe(false)
    expect(a.highpassHz).toBe(DEFAULT_AUDIO_ENHANCE.highpassHz)
    expect(a.compRatio).toBe(DEFAULT_AUDIO_ENHANCE.compRatio)
  })
})

describe('mergeAudioEnhance', () => {
  it('overrides only the patched fields and preserves the rest', () => {
    const base = makeAudioEnhance({ targetLufs: -16, compRatio: 3 })
    const merged = mergeAudioEnhance(base, { compRatio: 5 })
    expect(merged.compRatio).toBe(5) // patched
    expect(merged.targetLufs).toBe(-16) // preserved
  })

  it('does not mutate the base', () => {
    const base = makeAudioEnhance({ targetLufs: -16 })
    mergeAudioEnhance(base, { targetLufs: -9 })
    expect(base.targetLufs).toBe(-16)
  })
})

describe('AUDIO_PRESETS', () => {
  it('exposes the three named presets with unique ids and complete settings', () => {
    const ids = AUDIO_PRESETS.map((p) => p.id)
    expect(ids).toEqual(['voz', 'podcast', 'musica'])
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of AUDIO_PRESETS) {
      expect(p.settings).toEqual(makeAudioEnhance(p.settings))
    }
  })
})

describe('audioEnhanceIsIdentity', () => {
  it('is identity when undefined or disabled, active when enabled', () => {
    expect(audioEnhanceIsIdentity(undefined)).toBe(true)
    expect(audioEnhanceIsIdentity(makeAudioEnhance({ enabled: false }))).toBe(true)
    expect(audioEnhanceIsIdentity(makeAudioEnhance({ enabled: true }))).toBe(false)
  })
})

describe('buildEnhanceChain', () => {
  it('always includes compression then loudness LAST', () => {
    const chain = buildEnhanceChain(makeAudioEnhance())
    expect(chain).toContain('acompressor=')
    expect(chain).toContain('loudnorm=I=-16')
    // loudnorm comes after the compressor in the chain order.
    expect(chain.indexOf('acompressor=')).toBeLessThan(chain.indexOf('loudnorm='))
  })

  it('includes optional filters only when their toggle is on, gate before high-pass', () => {
    const on = buildEnhanceChain(makeAudioEnhance({ gate: true, highpassHz: 80, denoise: true, deEss: true, limiter: true }))
    expect(on.indexOf('agate=')).toBeLessThan(on.indexOf('highpass='))
    expect(on).toContain('afftdn=')
    expect(on).toContain('deesser=')
    expect(on).toContain('alimiter=')

    const off = buildEnhanceChain(makeAudioEnhance({ gate: false, denoise: false, deEss: false, limiter: false }))
    expect(off).not.toContain('agate=')
    expect(off).not.toContain('afftdn=')
    expect(off).not.toContain('deesser=')
    expect(off).not.toContain('alimiter=')
  })

  it('emits parametric EQ bands only when non-zero', () => {
    expect(buildEnhanceChain(makeAudioEnhance({ presenceDb: 0, mudDb: 0, airDb: 0, lowShelfDb: 0 }))).not.toContain('equalizer=')
    expect(buildEnhanceChain(makeAudioEnhance({ presenceDb: 4 }))).toContain('equalizer=f=4000')
  })

  it('wraps the chain in mono→dual-mono when centerStereo is on, and skips it when off', () => {
    const on = buildEnhanceChain(makeAudioEnhance({ centerStereo: true }))
    // Collapse to mono BEFORE processing; expand to dual-mono stereo AFTER loudnorm.
    expect(on.startsWith('aformat=channel_layouts=mono')).toBe(true)
    expect(on.endsWith('aformat=channel_layouts=stereo')).toBe(true)
    expect(on.indexOf('channel_layouts=mono')).toBeLessThan(on.indexOf('acompressor='))
    expect(on.indexOf('loudnorm=')).toBeLessThan(on.indexOf('channel_layouts=stereo'))

    expect(buildEnhanceChain(makeAudioEnhance({ centerStereo: false }))).not.toContain('channel_layouts')
  })
})
