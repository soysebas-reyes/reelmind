// SPDX-License-Identifier: GPL-3.0-or-later
// A privileged custom scheme that streams local media files to the sandboxed renderer so the preview
// can decode real video frames (the renderer cannot open arbitrary file:// under CSP).
//
// CRITICAL: <video>/<audio> seeking (multicam angle jumps, resume-after-pause, scrubbing) only works if
// the server honors HTTP Range requests — it must answer a `Range:` request with `206 Partial Content`
// + `Content-Range` and advertise `Accept-Ranges: bytes`. We serve ranges directly from disk with `fs`
// (a `createReadStream` slice) instead of relying on `net.fetch(file://)`, whose Range behavior is not
// guaranteed; without a proper 206 the element treats the media as non-seekable and always plays from 0.
//
// The renderer is our own trusted, CSP-locked bundle (no remote content), so encoding the absolute path
// in the URL is acceptable here. `corsEnabled` + the ACAO header keep decoded frames origin-clean for the
// WebGL color preview (cross-origin video frames would taint texImage2D).

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME } from '@core'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
}

function contentType(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export interface RangeResolution {
  /** 200 = full body, 206 = partial, 416 = unsatisfiable. */
  status: 200 | 206 | 416
  /** Inclusive byte offsets (valid for 200/206; for 200 they span the whole file). */
  start: number
  end: number
}

/** Parse an HTTP `Range` header against a known file `size` (bytes). Supports `bytes=start-`,
 *  `bytes=start-end`, and suffix `bytes=-N`. No/!malformed Range ⇒ full 200. Pure + unit-tested. */
export function resolveRange(rangeHeader: string | null | undefined, size: number): RangeResolution {
  const whole: RangeResolution = { status: 200, start: 0, end: Math.max(0, size - 1) }
  if (!rangeHeader) return whole
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!m || (m[1] === '' && m[2] === '')) return whole
  if (size <= 0) return { status: 416, start: 0, end: 0 }

  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = parseInt(m[2], 10)
    if (Number.isNaN(n) || n <= 0) return { status: 416, start: 0, end: 0 }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10)
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return whole
  if (end >= size) end = size - 1
  if (start < 0 || start > end || start >= size) return { status: 416, start: 0, end: 0 }
  return { status: 206, start, end }
}

/** Must run before app 'ready'. */
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

      const info = await stat(filePath)
      const size = info.size
      const headers = new Headers({
        'Access-Control-Allow-Origin': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType(filePath)
      })

      const range = resolveRange(request.headers.get('Range'), size)
      if (range.status === 416) {
        headers.set('Content-Range', `bytes */${size}`)
        return new Response(null, { status: 416, headers })
      }

      const length = size === 0 ? 0 : range.end - range.start + 1
      headers.set('Content-Length', String(length))
      if (range.status === 206) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`)

      if (size === 0) return new Response(null, { status: range.status, headers })
      // Stream exactly the requested byte slice from disk (createReadStream end is inclusive).
      const nodeStream = createReadStream(filePath, { start: range.start, end: range.end })
      const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
      return new Response(body, { status: range.status, headers })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 500 })
    }
  })
}
