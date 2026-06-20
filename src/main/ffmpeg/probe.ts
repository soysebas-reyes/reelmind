// SPDX-License-Identifier: GPL-3.0-or-later
// ffprobe wrapper: extract duration, dimensions, fps, and audio presence from a media file.

import { runFfprobeJson } from './binary'

export interface ProbeResult {
  durationSeconds: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  hasVideo: boolean
}

interface FfprobeStream {
  codec_type?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  duration?: string
  tags?: { rotate?: string }
  side_data_list?: { rotation?: number }[]
}

interface FfprobeOutput {
  format?: { duration?: string }
  streams?: FfprobeStream[]
}

function parseRational(value: string | undefined): number | undefined {
  if (!value) return undefined
  const [num, den] = value.split('/')
  const n = Number(num)
  const d = den === undefined ? 1 : Number(den)
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined
  const fps = n / d
  return fps > 0 ? fps : undefined
}

function rotationFor(stream: FfprobeStream): number {
  const tagRotate = stream.tags?.rotate ? Number(stream.tags.rotate) : 0
  const sideRotation = stream.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ?? 0
  // ffmpeg reports display-matrix rotation as a (often negative) degree value.
  return Math.abs((tagRotate || sideRotation) % 180)
}

export async function probeMedia(filePath: string): Promise<ProbeResult> {
  const out = (await runFfprobeJson([
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ])) as FfprobeOutput

  const streams = out.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')

  const result: ProbeResult = {
    durationSeconds: Number(out.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0,
    hasAudio: !!audio,
    hasVideo: !!video
  }

  if (video) {
    let w = video.width
    let h = video.height
    if (rotationFor(video) === 90 && w !== undefined && h !== undefined) {
      ;[w, h] = [h, w]
    }
    result.width = w
    result.height = h
    result.fps = parseRational(video.avg_frame_rate) ?? parseRational(video.r_frame_rate)
  }

  return result
}
