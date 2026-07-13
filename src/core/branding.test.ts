// SPDX-License-Identifier: GPL-3.0-or-later
// Guardrail: the renderer CSP is static HTML and cannot import MEDIA_SCHEME, so a scheme rename that
// misses index.html would make every <video>/<img> load fail SILENTLY (black preview, no crash).
// This test turns that divergence into a red `npm test`.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { APP_NAME, ASSET_DRAG_MIME, LAYOUT_STORAGE_KEY, MEDIA_SCHEME, mediaUrlForPath } from './branding'

const html = readFileSync(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), 'utf8')

describe('branding lockstep', () => {
  it('CSP allowlists the media scheme in img-src and media-src', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html.replace(/\s+/g, ' '))?.[1] ?? ''
    const directive = (name: string): string =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(`${name} `)) ?? ''
    expect(directive('img-src')).toContain(`${MEDIA_SCHEME}:`)
    expect(directive('media-src')).toContain(`${MEDIA_SCHEME}:`)
  })

  it('window title carries the app name', () => {
    expect(html).toContain(`<title>${APP_NAME}</title>`)
  })

  it('brand identifiers derive from one product name', () => {
    const slug = APP_NAME.toLowerCase()
    expect(MEDIA_SCHEME).toBe(`${slug}-media`)
    expect(ASSET_DRAG_MIME).toBe(`application/x-${slug}-asset`)
    expect(LAYOUT_STORAGE_KEY).toBe(`${slug}.layout`)
  })

  it('mediaUrlForPath encodes the absolute path under the scheme', () => {
    expect(mediaUrlForPath('C:\\clips\\a b.mp4')).toBe(`${MEDIA_SCHEME}://local/C%3A%5Cclips%5Ca%20b.mp4`)
    expect(mediaUrlForPath('/Users/x/a b.mp4')).toBe(`${MEDIA_SCHEME}://local/%2FUsers%2Fx%2Fa%20b.mp4`)
  })
})
