// SPDX-License-Identifier: GPL-3.0-or-later
// Generates a poster thumbnail (video/image) or a waveform image (audio) as a base64 data URL.
// Returned inline so the sandboxed renderer can show it under its `img-src data:` CSP.

import type { ClipType } from '../../core'
import { runFfmpegToBuffer } from './binary'

const THUMB_WIDTH = 320

export interface ThumbnailOptions {
  type: ClipType
  durationSeconds?: number
}

export async function generateThumbnail(filePath: string, opts: ThumbnailOptions): Promise<string | null> {
  try {
    if (opts.type === 'video') {
      const d = opts.durationSeconds ?? 0
      const seek = d > 1 ? Math.min(d * 0.25, 2).toFixed(3) : '0'
      const buf = await runFfmpegToBuffer([
        '-ss',
        seek,
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMB_WIDTH}:-2`,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ])
      return buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : null
    }

    if (opts.type === 'image') {
      const buf = await runFfmpegToBuffer([
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMB_WIDTH}:-2`,
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1'
      ])
      return buf.length ? `data:image/jpeg;base64,${buf.toString('base64')}` : null
    }

    if (opts.type === 'audio') {
      const buf = await runFfmpegToBuffer([
        '-i',
        filePath,
        '-filter_complex',
        `showwavespic=s=${THUMB_WIDTH}x80:colors=0x7c5cff`,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'png',
        'pipe:1'
      ])
      return buf.length ? `data:image/png;base64,${buf.toString('base64')}` : null
    }

    return null
  } catch {
    return null
  }
}
