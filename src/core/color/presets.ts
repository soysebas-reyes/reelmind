// SPDX-License-Identifier: GPL-3.0-or-later
// Color preset catalog (Phase 9.5): generic looks (merge onto the current grade) + the client
// "document" configs (full grades incl. a LUT reference). LUT BINARIES ARE NEVER BUNDLED — presets
// point to them by logical id and the host side-loads them from a user-configured folder
// (see src/main/color/lutResolver.ts). Values are verbatim from the source Lumetri panels:
// saturation stored as lumetri/100, contrast as 1 + lumetri/100; tonal regions on Lumetri's -100..100.

import { type ColorAdjustments, makeColorAdjustments } from '../model/color'

/** A generic look: a partial grade merged onto whatever the clip already has. */
export interface ColorLook {
  id: string
  name: string
  patch: Partial<ColorAdjustments>
}

/** A named, full grade (replaces the working draft when applied). May carry a LUT reference. */
export interface ColorPreset {
  id: string
  name: string
  group?: string
  cameraAngle?: 'frontal' | 'lateral'
  color: ColorAdjustments
  source?: string
  builtin: true
}

export const GENERIC_LOOKS: ColorLook[] = [
  { id: 'warm', name: 'Warm', patch: { temperature: 25 } },
  { id: 'cool', name: 'Cool', patch: { temperature: -25 } },
  { id: 'teal-orange', name: 'Teal & Orange', patch: { temperature: 12, saturation: 1.12, contrast: 1.12 } },
  { id: 'vintage', name: 'Vintage', patch: { temperature: 14, saturation: 0.8, contrast: 0.92 } },
  { id: 'bw', name: 'B&W', patch: { saturation: 0 } },
  { id: 'high-contrast', name: 'High Contrast', patch: { contrast: 1.3 } },
  { id: 'muted', name: 'Muted', patch: { saturation: 0.8 } },
  { id: 'vivid', name: 'Vivid', patch: { saturation: 1.25, contrast: 1.06 } }
]

const DOC_SOURCE = 'Guía de Parámetros de Colorización'

export const DOCUMENT_PRESETS: ColorPreset[] = [
  {
    id: 'guillermo-frontal-v1',
    name: 'Guillermo · Frontal · V.1',
    group: 'Primeros Reels (1–3)',
    cameraAngle: 'frontal',
    color: makeColorAdjustments({
      temperature: -7.4,
      tint: 4,
      saturation: 0.88,
      contrast: 1 - 21.1 / 100,
      shadows: 8.6,
      lutRef: 'preset:Color Guillermo - Frontal - V.1.cube',
      lutIntensity: 0.5
    }),
    source: DOC_SOURCE,
    builtin: true
  },
  {
    id: 'guillermo-lateral-v1',
    name: 'Guillermo · Lateral · V.1',
    group: 'Primeros Reels (1–3)',
    cameraAngle: 'lateral',
    color: makeColorAdjustments({
      temperature: -14.3,
      tint: 7.4,
      saturation: 0.88,
      exposure: 0.3,
      contrast: 1 - 29.1 / 100,
      shadows: -2.9,
      whites: 33.7,
      blacks: 0.6,
      lutRef: 'preset:Color Guillermo - Lateral - V.1.cube',
      lutIntensity: 0.5
    }),
    source: DOC_SOURCE,
    builtin: true
  },
  {
    id: 'guillermo-frontal-v2',
    name: 'Guillermo · Frontal · V.2',
    group: 'Segundos Reels (4–16)',
    cameraAngle: 'frontal',
    color: makeColorAdjustments({ lutRef: 'preset:Color Guillermo - Frontal - V.2.cube', lutIntensity: 0.5 }),
    source: DOC_SOURCE,
    builtin: true
  },
  {
    id: 'guillermo-lateral-v2',
    name: 'Guillermo · Lateral · V.2',
    group: 'Segundos Reels (4–16)',
    cameraAngle: 'lateral',
    color: makeColorAdjustments({ lutRef: 'preset:Color Guillermo - Lateral - V.2.cube', lutIntensity: 0.5 }),
    source: DOC_SOURCE,
    builtin: true
  }
]

export const presetById: Map<string, ColorPreset> = new Map(DOCUMENT_PRESETS.map((p) => [p.id, p]))
export const lookById: Map<string, ColorLook> = new Map(GENERIC_LOOKS.map((l) => [l.id, l]))
