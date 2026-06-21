// SPDX-License-Identifier: GPL-3.0-or-later
// Color model: neutral defaults, identity detection (incl. LUT), and partial merge.

import { describe, expect, it } from 'vitest'
import { IDENTITY_COLOR, colorIsIdentity, makeColorAdjustments, mergeColor } from './color'

describe('makeColorAdjustments', () => {
  it('defaults to the neutral identity', () => {
    expect(makeColorAdjustments()).toEqual(IDENTITY_COLOR)
  })

  it('keeps provided fields and fills the rest with neutral defaults', () => {
    const c = makeColorAdjustments({ saturation: 0.88, contrast: 0.789, shadows: 8.6 })
    expect(c.saturation).toBe(0.88)
    expect(c.contrast).toBe(0.789)
    expect(c.shadows).toBe(8.6)
    expect(c.exposure).toBe(0)
    expect(c.gamma).toBe(1)
    expect(c.lutIntensity).toBe(1)
    expect(c.lutRef).toBeUndefined()
  })
})

describe('colorIsIdentity', () => {
  it('is true for the neutral default', () => {
    expect(colorIsIdentity(makeColorAdjustments())).toBe(true)
    expect(colorIsIdentity(IDENTITY_COLOR)).toBe(true)
  })

  it('is false when any numeric knob is off-neutral', () => {
    expect(colorIsIdentity(makeColorAdjustments({ saturation: 0.88 }))).toBe(false)
    expect(colorIsIdentity(makeColorAdjustments({ shadows: 8.6 }))).toBe(false)
    expect(colorIsIdentity(makeColorAdjustments({ contrast: 1.2 }))).toBe(false)
    expect(colorIsIdentity(makeColorAdjustments({ exposure: 0.3 }))).toBe(false)
  })

  it('treats an active LUT as non-identity, but a LUT at intensity 0 as identity', () => {
    expect(colorIsIdentity(makeColorAdjustments({ lutRef: 'preset:x', lutIntensity: 0.5 }))).toBe(false)
    expect(colorIsIdentity(makeColorAdjustments({ lutRef: 'preset:x', lutIntensity: 1 }))).toBe(false)
    expect(colorIsIdentity(makeColorAdjustments({ lutRef: 'preset:x', lutIntensity: 0 }))).toBe(true)
  })
})

describe('mergeColor', () => {
  it('overrides only the patched fields and preserves the rest', () => {
    const base = makeColorAdjustments({ saturation: 0.88, temperature: -7.4 })
    const merged = mergeColor(base, { saturation: 1.1 })
    expect(merged.saturation).toBe(1.1) // patched
    expect(merged.temperature).toBe(-7.4) // preserved
    expect(merged.contrast).toBe(1) // untouched
  })

  it('does not mutate the base', () => {
    const base = makeColorAdjustments({ saturation: 0.88 })
    mergeColor(base, { saturation: 1.2 })
    expect(base.saturation).toBe(0.88)
  })
})
