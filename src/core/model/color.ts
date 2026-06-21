// SPDX-License-Identifier: GPL-3.0-or-later
// Per-clip color grading adjustments (Phase 9.5). Plain JSON so it persists in `.vproj` for free,
// and neutral-by-default so an un-graded clip is identity and emits no filters / renders bit-for-bit
// as before. The four tonal regions (highlights/shadows/whites/blacks) use Lumetri's native
// -100..100 scale so the document presets store verbatim. The exact FFmpeg mapping lives in
// ../export/colorFilters.ts; the approximate Canvas-preview mapping lives in the renderer.

export interface ColorAdjustments {
  exposure: number // -2..2 stops              (0)
  brightness: number // -1..1                  (0)
  contrast: number // 0..2                     (1)
  saturation: number // 0..2                   (1)
  temperature: number // -100..100 cool..warm  (0)
  tint: number // -100..100 green..magenta     (0)
  hue: number // -180..180 deg                 (0)
  gamma: number // 0.1..3                       (1)
  // Tonal regions (Lumetri Resaltados/Sombras/Blancos/Negros) on the native -100..100 scale.
  highlights: number // -100..100              (0)
  shadows: number // -100..100                 (0)
  whites: number // -100..100                  (0)
  blacks: number // -100..100                  (0)
  lutRef?: string // logical id / project-relative path; resolved to a .cube at render time
  lutIntensity: number // 0..1                  (1)
}

export const IDENTITY_COLOR: ColorAdjustments = {
  exposure: 0,
  brightness: 0,
  contrast: 1,
  saturation: 1,
  temperature: 0,
  tint: 0,
  hue: 0,
  gamma: 1,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  lutIntensity: 1
}

export function makeColorAdjustments(p: Partial<ColorAdjustments> = {}): ColorAdjustments {
  return {
    exposure: p.exposure ?? 0,
    brightness: p.brightness ?? 0,
    contrast: p.contrast ?? 1,
    saturation: p.saturation ?? 1,
    temperature: p.temperature ?? 0,
    tint: p.tint ?? 0,
    hue: p.hue ?? 0,
    gamma: p.gamma ?? 1,
    highlights: p.highlights ?? 0,
    shadows: p.shadows ?? 0,
    whites: p.whites ?? 0,
    blacks: p.blacks ?? 0,
    lutRef: p.lutRef,
    lutIntensity: p.lutIntensity ?? 1
  }
}

/** True when nothing would change a pixel: every numeric knob neutral AND no active LUT (a LUT at
 *  intensity 0 is also identity). Gates all filter emission so un-graded clips stay untouched. */
export function colorIsIdentity(c: ColorAdjustments): boolean {
  const lutActive = !!c.lutRef && c.lutIntensity > 0
  return (
    !lutActive &&
    c.exposure === 0 &&
    c.brightness === 0 &&
    c.contrast === 1 &&
    c.saturation === 1 &&
    c.temperature === 0 &&
    c.tint === 0 &&
    c.hue === 0 &&
    c.gamma === 1 &&
    c.highlights === 0 &&
    c.shadows === 0 &&
    c.whites === 0 &&
    c.blacks === 0
  )
}

/** Merge a partial patch onto a base so editing one slider doesn't reset the others. */
export function mergeColor(base: ColorAdjustments, patch: Partial<ColorAdjustments>): ColorAdjustments {
  return { ...base, ...patch }
}
