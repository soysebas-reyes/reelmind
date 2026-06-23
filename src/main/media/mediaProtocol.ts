// SPDX-License-Identifier: GPL-3.0-or-later
// A privileged custom scheme that streams local media files to the sandboxed renderer so the
// preview can decode real video frames (the renderer cannot open arbitrary file:// under CSP).
// Range requests (needed for video seeking) are honored by delegating to net.fetch on a file URL.
//
// The renderer is our own trusted, CSP-locked bundle (no remote content), so encoding the absolute
// path in the URL is acceptable here.

import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'

export const MEDIA_SCHEME = 'reelmind-media'

/** Must run before app 'ready'. `corsEnabled` (+ the ACAO header below + `crossOrigin` on the media
 *  elements) keeps decoded video frames origin-clean so the WebGL color preview can upload them as
 *  textures — without it, cross-origin frames are "tainted" and `texImage2D(video)` throws. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false
      }
    }
  ])
}

/** Must run after app 'ready'. */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      if (!filePath) return new Response('Bad media request', { status: 400 })
      const res = await net.fetch(pathToFileURL(filePath).toString(), { headers: request.headers })
      // Re-emit with CORS allowed so the renderer (a different origin) can use the bytes in WebGL.
      // All upstream headers (Content-Range/Length/Type for seeking) are preserved.
      const headers = new Headers(res.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 })
    }
  })
}

/** Build a renderer-usable URL for an absolute local file path. */
export function mediaUrlForPath(absolutePath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absolutePath)}`
}
