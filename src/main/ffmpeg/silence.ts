// SPDX-License-Identifier: GPL-3.0-or-later
// Detect silent spans in a media file's audio via FFmpeg `silencedetect`. The log parser is pure and
// unit-tested; detectSilences runs ffmpeg and feeds it the captured stderr.

import { spawn } from 'node:child_process'
import type { SilenceSeconds } from '../../core'
import { ffmpegBinary } from './binary'

/** Parse ffmpeg `silencedetect` stderr into source-second ranges. A dangling start (silence runs to
 *  EOF, so ffmpeg never prints silence_end) is closed with Infinity for the caller to clamp. */
export function parseSilenceLog(log: string): SilenceSeconds[] {
  const ranges: SilenceSeconds[] = []
  let start: number | null = null
  for (const line of log.split('\n')) {
    const sm = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (sm) {
      start = Number(sm[1])
      continue
    }
    const em = line.match(/silence_end:\s*(-?[\d.]+)/)
    if (em && start !== null) {
      ranges.push({ start, end: Number(em[1]) })
      start = null
    }
  }
  if (start !== null) ranges.push({ start, end: Number.POSITIVE_INFINITY })
  return ranges
}

export interface DetectSilenceOptions {
  /** dBFS threshold below which audio counts as silent (default -30). */
  noiseDb?: number
  /** Minimum silence length to report, in seconds (default 0.5). */
  minDurationSec?: number
}

/** Run silencedetect on `path` and return the silent spans (source seconds). Resolves to an empty
 *  array if the file has no audio. */
export async function detectSilences(path: string, opts: DetectSilenceOptions = {}): Promise<SilenceSeconds[]> {
  const noiseDb = opts.noiseDb ?? -30
  const minDur = opts.minDurationSec ?? 0.5
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-af',
    `silencedetect=noise=${noiseDb}dB:d=${minDur}`,
    '-f',
    'null',
    '-'
  ]
  return new Promise<SilenceSeconds[]>((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 1_000_000) stderr = stderr.slice(-1_000_000)
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', () => resolve(parseSilenceLog(stderr)))
  })
}
