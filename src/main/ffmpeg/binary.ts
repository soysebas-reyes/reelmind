// SPDX-License-Identifier: GPL-3.0-or-later
// Resolves and runs the FFmpeg / ffprobe binaries. Phase 1 uses the system binaries on PATH
// (overridable via env); a pinned bundled binary comes in the packaging phase.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function ffmpegBinary(): string {
  return process.env.REELO_FFMPEG || 'ffmpeg'
}

export function ffprobeBinary(): string {
  return process.env.REELO_FFPROBE || 'ffprobe'
}

export interface FfmpegStatus {
  ffmpeg: boolean
  ffprobe: boolean
  ffmpegVersion?: string
}

export async function checkFfmpeg(): Promise<FfmpegStatus> {
  const status: FfmpegStatus = { ffmpeg: false, ffprobe: false }
  try {
    const { stdout } = await execFileAsync(ffmpegBinary(), ['-version'], { windowsHide: true })
    status.ffmpeg = true
    status.ffmpegVersion = stdout.split('\n')[0]?.trim()
  } catch {
    // not found
  }
  try {
    await execFileAsync(ffprobeBinary(), ['-version'], { windowsHide: true })
    status.ffprobe = true
  } catch {
    // not found
  }
  return status
}

/** Run ffprobe and parse its JSON output. */
export async function runFfprobeJson(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(ffprobeBinary(), args, {
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024
  })
  return JSON.parse(stdout)
}

/** Run ffmpeg, capturing stdout as a Buffer (used for piping a single thumbnail frame out). */
export async function runFfmpegToBuffer(args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync(ffmpegBinary(), args, {
    windowsHide: true,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024
  })
  return stdout as unknown as Buffer
}
