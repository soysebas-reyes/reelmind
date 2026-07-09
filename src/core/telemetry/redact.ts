// SPDX-License-Identifier: GPL-3.0-or-later
// Redaction backstop — the privacy boundary. Runs renderer-side at capture (so raw paths never
// cross IPC) and is re-validated main-side by telemetryEventSchema (defense in depth).
// Guarantees props are safe primitives, PII-free, size-capped, and JSON-serializable.

import type { TelemetryProps } from './event'

const MAX_VALUE_CHARS = 120
const MAX_TOTAL_CHARS = 2048

// A string value is sensitive (a path / URL / media reference / email) and must be replaced,
// not just truncated, so the *shape* of the leak is preserved without the content.
const PATH_LIKE =
  /(^[a-zA-Z]:[\\/])|(^\\\\)|(^\/)|(^file:)|(https?:\/\/)|(^data:)|(\.(mp4|mov|mkv|avi|webm|wav|mp3|aac|m4a|flac|ogg|png|jpe?g|gif|bmp|tiff?|srt|vtt|json|vproj|lut|cube)(\?|#|$))/i
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/

/** Replace sensitive strings with a marker; truncate long ones. */
export function scrubString(s: string): string {
  if (EMAIL.test(s)) return '[redacted:email]'
  if (PATH_LIKE.test(s)) return '[redacted:path]'
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) + '…' : s
}

/**
 * Coerce an arbitrary props bag to safe, PII-free primitives.
 * - strings → scrubbed (path/URL/media/email markers, length-capped)
 * - number/boolean/null → kept (non-finite numbers → null)
 * - arrays → joined to a scrubbed string (kept as `<key>` value; safe when call sites pass name lists)
 * - objects/functions/undefined → dropped
 * - total serialized size capped; keys processed in stable (sorted) order
 */
export function redactProps(raw?: Record<string, unknown> | null): TelemetryProps | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: TelemetryProps = {}
  let total = 0
  for (const key of Object.keys(raw).sort()) {
    const v = raw[key]
    let val: string | number | boolean | null
    if (typeof v === 'string') val = scrubString(v)
    else if (typeof v === 'number') val = Number.isFinite(v) ? v : null
    else if (typeof v === 'boolean') val = v
    else if (v === null) val = null
    else if (Array.isArray(v)) val = scrubString(v.map((x) => String(x)).join(','))
    else continue // objects, functions, undefined, symbols → dropped
    if (typeof val === 'string') {
      total += val.length
      if (total > MAX_TOTAL_CHARS) continue
    }
    out[key] = val
  }
  return Object.keys(out).length > 0 ? out : undefined
}
