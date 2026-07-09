// SPDX-License-Identifier: GPL-3.0-or-later
// Golden cases for the privacy backstop. If any of these regress, PII could leak into telemetry.

import { describe, expect, it } from 'vitest'
import { redactProps, scrubString } from './redact'

describe('scrubString', () => {
  it('replaces Windows absolute paths', () => {
    expect(scrubString('D:\\crudos\\toma1.mp4')).toBe('[redacted:path]')
    expect(scrubString('C:/cache/proxy.mp4')).toBe('[redacted:path]')
  })

  it('replaces UNC paths, file:// and http(s) URLs, and data: URIs', () => {
    expect(scrubString('\\\\nas\\share\\a.mov')).toBe('[redacted:path]')
    expect(scrubString('file:///Users/x/v.mov')).toBe('[redacted:path]')
    expect(scrubString('https://example.com/x')).toBe('[redacted:path]')
    expect(scrubString('data:image/png;base64,AAAA')).toBe('[redacted:path]')
  })

  it('replaces bare media/project filenames by extension', () => {
    expect(scrubString('entrevista final.mp4')).toBe('[redacted:path]')
    expect(scrubString('mi proyecto.vproj')).toBe('[redacted:path]')
  })

  it('replaces emails', () => {
    expect(scrubString('hola sebastian@example.com')).toBe('[redacted:email]')
  })

  it('truncates long strings', () => {
    const out = scrubString('a'.repeat(500))
    expect(out.length).toBe(121)
    expect(out.endsWith('…')).toBe(true)
  })

  it('passes safe short strings through unchanged', () => {
    expect(scrubString('command.split_clip')).toBe('command.split_clip')
    expect(scrubString('timeline')).toBe('timeline')
    expect(scrubString('saveProject')).toBe('saveProject')
  })
})

describe('redactProps', () => {
  it('keeps safe primitives and scrubs sensitive string values', () => {
    const out = redactProps({
      x: 0.5,
      ok: true,
      nothing: null,
      panel: 'timeline',
      path: 'D:\\crudos\\toma1.mp4'
    })
    expect(out).toEqual({ x: 0.5, ok: true, nothing: null, panel: 'timeline', path: '[redacted:path]' })
  })

  it('drops nested objects and coerces non-finite numbers to null', () => {
    const out = redactProps({ nested: { a: 1 }, bad: NaN, inf: Infinity, keep: 3 })
    expect(out).toEqual({ bad: null, inf: null, keep: 3 })
    expect(out && 'nested' in out).toBe(false)
  })

  it('joins arrays into a scrubbed string (arg-name lists stay safe)', () => {
    expect(redactProps({ args: ['clipId', 'frame'] })).toEqual({ args: 'clipId,frame' })
  })

  it('returns undefined for empty/absent input', () => {
    expect(redactProps(undefined)).toBeUndefined()
    expect(redactProps({})).toBeUndefined()
    expect(redactProps({ dropMe: { a: 1 } })).toBeUndefined()
  })

  it('output is always JSON-serializable', () => {
    const out = redactProps({ a: 'x', b: 2, c: false, d: null, e: ['p', 'q'] })
    expect(() => JSON.stringify(out)).not.toThrow()
  })
})
