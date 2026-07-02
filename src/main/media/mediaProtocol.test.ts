// SPDX-License-Identifier: GPL-3.0-or-later
// HTTP Range parsing for the media protocol. Correct 206/Content-Range is what makes <video>/<audio>
// seekable (multicam angle jumps, resume-after-pause, scrubbing) instead of always playing from 0.

import { describe, expect, it } from 'vitest'
import { resolveRange } from './mediaProtocol'

const SIZE = 1000

describe('resolveRange', () => {
  it('no Range header → full 200 over the whole file', () => {
    expect(resolveRange(null, SIZE)).toEqual({ status: 200, start: 0, end: 999 })
    expect(resolveRange(undefined, SIZE)).toEqual({ status: 200, start: 0, end: 999 })
  })

  it('open-ended "bytes=0-" → 206 spanning the whole file (the element\'s initial seekable probe)', () => {
    expect(resolveRange('bytes=0-', SIZE)).toEqual({ status: 206, start: 0, end: 999 })
  })

  it('"bytes=N-" (seek forward) → 206 from N to EOF — this is the multicam angle jump', () => {
    expect(resolveRange('bytes=400-', SIZE)).toEqual({ status: 206, start: 400, end: 999 })
  })

  it('closed range "bytes=100-200" → 206 of exactly that slice', () => {
    expect(resolveRange('bytes=100-200', SIZE)).toEqual({ status: 206, start: 100, end: 200 })
  })

  it('suffix "bytes=-100" → 206 of the last 100 bytes', () => {
    expect(resolveRange('bytes=-100', SIZE)).toEqual({ status: 206, start: 900, end: 999 })
  })

  it('clamps an end past EOF to the last byte', () => {
    expect(resolveRange('bytes=500-999999', SIZE)).toEqual({ status: 206, start: 500, end: 999 })
  })

  it('start at/after EOF → 416 unsatisfiable', () => {
    expect(resolveRange('bytes=1000-', SIZE).status).toBe(416)
    expect(resolveRange('bytes=5000-6000', SIZE).status).toBe(416)
  })

  it('malformed Range → falls back to full 200', () => {
    expect(resolveRange('bytes=abc', SIZE).status).toBe(200)
    expect(resolveRange('pages=0-1', SIZE).status).toBe(200)
  })

  it('empty file with a Range → 416', () => {
    expect(resolveRange('bytes=0-', 0).status).toBe(416)
  })
})
