// SPDX-License-Identifier: GPL-3.0-or-later
// LUT resolution: candidate ordering (pure) + existence-based resolution against a temp dir.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { lutCandidatePaths, resolveLut } from './lutResolver'

describe('lutCandidatePaths', () => {
  it('maps each scheme to the right directory', () => {
    expect(lutCandidatePaths('preset:x.cube', { libraryDir: '/lib' })).toEqual([join('/lib', 'x.cube')])
    expect(lutCandidatePaths('profile:x.cube', { profileDir: '/prof' })).toEqual([join('/prof', 'x.cube')])
    expect(lutCandidatePaths('C:/abs/x.cube', {})).toEqual(['C:/abs/x.cube'])
  })

  it('yields no candidates when the needed directory is absent', () => {
    expect(lutCandidatePaths('preset:x.cube', {})).toEqual([])
    expect(lutCandidatePaths('profile:x.cube', {})).toEqual([])
  })
})

describe('resolveLut', () => {
  it('finds a preset LUT in the library dir, and is null when missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reelo-lut-'))
    writeFileSync(join(dir, 'look.cube'), 'TITLE "x"\nLUT_3D_SIZE 2\n')
    expect(resolveLut('preset:look.cube', { libraryDir: dir })).toBe(join(dir, 'look.cube'))
    expect(resolveLut('preset:missing.cube', { libraryDir: dir })).toBeNull()
    expect(resolveLut('preset:look.cube', { libraryDir: null })).toBeNull()
  })
})
