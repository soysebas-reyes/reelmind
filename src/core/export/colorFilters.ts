// SPDX-License-Identifier: GPL-3.0-or-later
// Color grading → FFmpeg filtergraph (Phase 9.5). The ONE place ColorAdjustments becomes filters,
// reused by the export graph (per visual clip) AND the still-preview renderer (one frame) so the
// Explorer preview matches the final render exactly.
//
// Order matches Lumetri ("LUT as base, then grade"): lut3d first, then eq → colorbalance → curves.
// LUT intensity < 1 is a split+blend (lut3d has no opacity). Mapping constants for the Lumetri-style
// knobs (exposure/temperature/tint/tonal) are APPROXIMATE and meant to be calibrated against the
// reference stills, then locked by the export-graph golden tests.

import type { ColorAdjustments } from '../model/color'

// --- Calibration constants (approximate; tune against reference stills, lock with tests) ---
const EXPOSURE_TO_BRIGHTNESS = 0.1 // eq.brightness added per exposure "stop" unit
const TEMP_RB = 0.005 // colorbalance red/blue shift per temperature unit (-100..100 → ∓0.5)
const TINT_G = 0.005 // colorbalance green shift per tint unit (-100..100 → ∓0.5)
const TONAL_LIFT = 0.005 // curves y-lift per tonal unit (-100..100 → ∓0.5)

function fmt(n: number): string {
  return Number(n.toFixed(6)).toString()
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** The comma-joinable grade filters (everything except the LUT): eq, hue, colorbalance, curves.
 *  Each piece is emitted only when its field is off-neutral, so a near-neutral grade stays short. */
export function gradeFilters(color: ColorAdjustments): string[] {
  const out: string[] = []

  const eq: string[] = []
  const brightness = color.brightness + color.exposure * EXPOSURE_TO_BRIGHTNESS
  if (brightness !== 0) eq.push(`brightness=${fmt(brightness)}`)
  if (color.contrast !== 1) eq.push(`contrast=${fmt(color.contrast)}`)
  if (color.saturation !== 1) eq.push(`saturation=${fmt(color.saturation)}`)
  if (color.gamma !== 1) eq.push(`gamma=${fmt(color.gamma)}`)
  if (eq.length > 0) out.push(`eq=${eq.join(':')}`)

  if (color.hue !== 0) out.push(`hue=h=${fmt(color.hue)}`)

  // Temperature + tint as one midtone colorbalance (predictable; negative temp = cooler = +blue/-red,
  // positive tint = magenta = -green).
  if (color.temperature !== 0 || color.tint !== 0) {
    const rm = color.temperature * TEMP_RB
    const bm = -color.temperature * TEMP_RB
    const gm = -color.tint * TINT_G
    const parts: string[] = []
    if (rm !== 0) parts.push(`rm=${fmt(rm)}`)
    if (gm !== 0) parts.push(`gm=${fmt(gm)}`)
    if (bm !== 0) parts.push(`bm=${fmt(bm)}`)
    if (parts.length > 0) out.push(`colorbalance=${parts.join(':')}`)
  }

  const curve = curvesExpr(color)
  if (curve) out.push(`curves=all='${curve}'`)

  return out
}

/** Lumetri tone regions → one `curves` control-point string, or null when all four are neutral.
 *  blacks moves the black point (x=0), shadows x=0.25, highlights x=0.75, whites near-white x=0.95. */
function curvesExpr(color: ColorAdjustments): string | null {
  const { highlights, shadows, whites, blacks } = color
  if (highlights === 0 && shadows === 0 && whites === 0 && blacks === 0) return null
  const pts: string[] = [`0/${fmt(clamp01(blacks * TONAL_LIFT))}`]
  if (shadows !== 0) pts.push(`0.25/${fmt(clamp01(0.25 + shadows * TONAL_LIFT))}`)
  if (highlights !== 0) pts.push(`0.75/${fmt(clamp01(0.75 + highlights * TONAL_LIFT))}`)
  if (whites !== 0) pts.push(`0.95/${fmt(clamp01(0.95 + whites * TONAL_LIFT))}`)
  pts.push('1/1')
  return pts.join(' ')
}

function lut3d(path: string): string {
  // FFmpeg filtergraph path escaping (Windows-safe): forward slashes, escape ':' and "'", then quote.
  // A bare drive colon (C:) breaks the graph even inside quotes, so it must be backslash-escaped.
  const escaped = path.replace(/\\/g, '/').replace(/[:']/g, '\\$&')
  return `lut3d=file='${escaped}':interp=tetrahedral`
}

/** Build the color stage as `;`-separated filtergraph segments transforming `inLabel` → `outLabel`.
 *  Caller guarantees the color is non-identity. `lutPath` is the resolved .cube path or null (a
 *  missing/unresolved LUT is skipped gracefully — the grade still applies). When the LUT intensity is
 *  in (0,1) it becomes a split+blend; otherwise everything folds into one comma-joined segment. */
export function buildColorFilterChain(
  color: ColorAdjustments,
  lutPath: string | null,
  inLabel: string,
  outLabel: string
): string[] {
  const grade = gradeFilters(color)
  const lutActive = !!lutPath && color.lutIntensity > 0

  if (lutActive && color.lutIntensity < 1 - 1e-9) {
    const core = outLabel.replace(/[[\]]/g, '')
    const a = `[${core}_a]` // original (pre-LUT)
    const b = `[${core}_b]` // LUT input
    const l = `[${core}_l]` // LUT output
    const i = color.lutIntensity
    const blend = `blend=all_expr='A*${fmt(i)}+B*${fmt(1 - i)}'` // A=lut, B=original → i·lut + (1-i)·orig
    const tail = grade.length > 0 ? `,${grade.join(',')}` : ''
    return [
      `${inLabel}split${a}${b}`,
      `${b}${lut3d(lutPath as string)}${l}`,
      `${l}${a}${blend}${tail}${outLabel}`
    ]
  }

  const filters: string[] = []
  if (lutActive) filters.push(lut3d(lutPath as string))
  filters.push(...grade)
  return [`${inLabel}${filters.length > 0 ? filters.join(',') : 'null'}${outLabel}`]
}
