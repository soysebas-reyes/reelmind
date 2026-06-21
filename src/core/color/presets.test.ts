// SPDX-License-Identifier: GPL-3.0-or-later
// Preset catalog + lutRef parsing.

import { describe, expect, it } from 'vitest'
import { parseLutRef } from './lut'
import { DOCUMENT_PRESETS, GENERIC_LOOKS, lookById, presetById } from './presets'

describe('document presets', () => {
  it('ships the four Guillermo configs with verbatim values', () => {
    const f1 = presetById.get('guillermo-frontal-v1')!
    expect(f1.color.saturation).toBeCloseTo(0.88, 6)
    expect(f1.color.contrast).toBeCloseTo(0.789, 6) // Lumetri -21.1 → 1 + (-21.1/100)
    expect(f1.color.temperature).toBe(-7.4)
    expect(f1.color.tint).toBe(4)
    expect(f1.color.shadows).toBe(8.6)
    expect(f1.color.lutIntensity).toBe(0.5)
    expect(f1.color.lutRef).toBe('preset:Color Guillermo - Frontal - V.1.cube')

    const l1 = presetById.get('guillermo-lateral-v1')!
    expect(l1.color.contrast).toBeCloseTo(0.709, 6) // -29.1
    expect(l1.color.whites).toBe(33.7)
    expect(l1.color.blacks).toBe(0.6)

    const f2 = presetById.get('guillermo-frontal-v2')!
    expect(f2.color.saturation).toBe(1) // V.2 look carried entirely by the LUT
    expect(f2.color.lutIntensity).toBe(0.5)
    expect(f2.color.lutRef).toBe('preset:Color Guillermo - Frontal - V.2.cube')
  })

  it('every document preset references a preset-scheme LUT (binaries never bundled)', () => {
    for (const p of DOCUMENT_PRESETS) {
      expect(p.color.lutRef?.startsWith('preset:')).toBe(true)
      expect(p.builtin).toBe(true)
    }
  })

  it('ships generic looks as partial patches', () => {
    expect(GENERIC_LOOKS.length).toBeGreaterThan(4)
    expect(lookById.get('bw')!.patch.saturation).toBe(0)
    expect(lookById.get('vivid')!.patch.saturation).toBeGreaterThan(1)
  })
})

describe('parseLutRef', () => {
  it('classifies the scheme and extracts the name', () => {
    expect(parseLutRef('preset:Color X.cube')).toEqual({ scheme: 'preset', name: 'Color X.cube' })
    expect(parseLutRef('profile:my.cube')).toEqual({ scheme: 'profile', name: 'my.cube' })
    expect(parseLutRef('C:/luts/x.cube')).toEqual({ scheme: 'absolute', name: 'C:/luts/x.cube' })
    expect(parseLutRef('/luts/x.cube')).toEqual({ scheme: 'absolute', name: '/luts/x.cube' })
    expect(parseLutRef('luts/x.cube')).toEqual({ scheme: 'project', name: 'luts/x.cube' })
  })
})
