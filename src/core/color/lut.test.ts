// SPDX-License-Identifier: GPL-3.0-or-later
// .cube parsing: lutRef scheme detection + 3D LUT parse (size, red-fastest order, domain, errors).

import { describe, expect, it } from 'vitest'
import { parseCubeLut, parseLutRef } from './lut'

describe('parseLutRef', () => {
  it('detects each scheme', () => {
    expect(parseLutRef('preset:a.cube')).toEqual({ scheme: 'preset', name: 'a.cube' })
    expect(parseLutRef('profile:b.cube')).toEqual({ scheme: 'profile', name: 'b.cube' })
    expect(parseLutRef('C:/x/c.cube')).toEqual({ scheme: 'absolute', name: 'C:/x/c.cube' })
    expect(parseLutRef('/x/d.cube')).toEqual({ scheme: 'absolute', name: '/x/d.cube' })
    expect(parseLutRef('luts/e.cube')).toEqual({ scheme: 'project', name: 'luts/e.cube' })
  })
})

// A minimal identity 2×2×2 LUT (red varies fastest), with a comment, TITLE, and blank lines.
const IDENTITY_2 = `# a comment
TITLE "id"
LUT_3D_SIZE 2

0 0 0
1 0 0
0 1 0
1 1 0
0 0 1
1 0 1
0 1 1
1 1 1
`

describe('parseCubeLut', () => {
  it('parses size and preserves red-fastest order', () => {
    const lut = parseCubeLut(IDENTITY_2)
    expect(lut.size).toBe(2)
    expect(lut.data).toHaveLength(2 * 2 * 2 * 3)
    // entry[1] = (1,0,0) → red changed first
    expect(Array.from(lut.data.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0])
    // last entry = (1,1,1)
    expect(Array.from(lut.data.slice(-3))).toEqual([1, 1, 1])
  })

  it('normalizes DOMAIN_MIN/MAX back to 0..1', () => {
    const scaled = `LUT_3D_SIZE 2
DOMAIN_MIN 0 0 0
DOMAIN_MAX 255 255 255
0 0 0
255 0 0
0 255 0
255 255 0
0 0 255
255 0 255
0 255 255
255 255 255
`
    const lut = parseCubeLut(scaled)
    expect(Array.from(lut.data.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0])
    expect(Array.from(lut.data.slice(-3))).toEqual([1, 1, 1])
  })

  it('throws on a 1D LUT', () => {
    expect(() => parseCubeLut('LUT_1D_SIZE 16\n')).toThrow(/1D/)
  })

  it('throws when no 3D size is declared', () => {
    expect(() => parseCubeLut('0 0 0\n1 1 1\n')).toThrow(/not a 3D/)
  })

  it('throws when the entry count does not match size³', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/mismatch/)
  })
})
