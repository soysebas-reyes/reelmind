// SPDX-License-Identifier: GPL-3.0-or-later
// Time formatting shared by the takes verification modal and the editable preview. `mmss`/`parseMmss`
// are inverses over the `m:ss.d` form (e.g. "1:04.5"), so a value shown in a field round-trips cleanly.

/** ms → "m:ss.d" (e.g. 64500 → "1:04.5"). Clamps negatives to 0. */
export function mmss(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const rem = total - m * 60
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`
}

/** Parse "m:ss.d", "m:ss", "ss.d" or "ss" back to ms. Returns null on anything malformed so callers can
 *  reject the edit silently instead of writing a NaN boundary. Seconds must be < 60 when minutes are given. */
export function parseMmss(str: string): number | null {
  const s = str.trim()
  if (!s) return null
  const parts = s.split(':')
  if (parts.length > 2) return null
  let minutes = 0
  let secondsStr = s
  if (parts.length === 2) {
    const minStr = parts[0].trim()
    if (!/^\d+$/.test(minStr)) return null
    minutes = parseInt(minStr, 10)
    secondsStr = parts[1].trim()
  }
  if (!/^\d+(\.\d+)?$/.test(secondsStr)) return null
  const seconds = parseFloat(secondsStr)
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null
  if (parts.length === 2 && seconds >= 60) return null
  return Math.round((minutes * 60 + seconds) * 1000)
}
