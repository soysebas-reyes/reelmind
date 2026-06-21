// SPDX-License-Identifier: GPL-3.0-or-later
// Renders ONE color-graded still frame as a base64 data URL — the exact preview for the Phase 9.5
// Colorization Explorer. It reuses `buildColorFilterChain` (the same code the export graph uses), so
// the preview a user sees equals the final render. The LUT path is resolved by the caller (IPC) so
// this stays a thin ffmpeg wrapper.

import { type ColorAdjustments, buildColorFilterChain, colorIsIdentity } from '../../core'
import { runFfmpegToBuffer } from './binary'

export interface ColorStillOptions {
  width?: number
  /** Absolute .cube path (already resolved), or null to render without a LUT. */
  lutPath?: string | null
}

export async function generateStillWithColor(
  filePath: string,
  seekSeconds: number,
  color: ColorAdjustments,
  opts: ColorStillOptions = {}
): Promise<string | null> {
  const width = opts.width ?? 480
  // Same filter chain as the export, just for one downscaled frame (scale BEFORE lut3d → cheap).
  const segments = colorIsIdentity(color)
    ? [`[0:v]scale=${width}:-2[cout]`]
    : [`[0:v]scale=${width}:-2[cin]`, ...buildColorFilterChain(color, opts.lutPath ?? null, '[cin]', '[cout]')]
  const buf = await runFfmpegToBuffer([
    '-ss',
    Math.max(0, seekSeconds).toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-filter_complex',
    segments.join(';'),
    '-map',
    '[cout]',
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    'pipe:1'
  ])
  return buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : null
}
