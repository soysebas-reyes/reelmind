// SPDX-License-Identifier: GPL-3.0-or-later
// Integration test: actually render a small multi-track project to mp4 with the real FFmpeg and
// probe the result. Synthesizes its inputs with lavfi. Self-skips if ffmpeg/ffprobe are absent.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type MediaManifest, makeClip, makeManifest, makeTimeline, makeTrack } from '@core'
import { checkFfmpeg, ffmpegBinary, runFfprobeJson } from './index'
import { exportTimeline } from './exporter'

const execFileAsync = promisify(execFile)
const status = await checkFfmpeg()
const haveFfmpeg = status.ffmpeg && status.ffprobe

let dir = ''
let videoPath = ''
let imagePath = ''
let audioPath = ''

describe.skipIf(!haveFfmpeg)('timeline export (integration, requires ffmpeg)', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'reelmind-export-'))
    videoPath = join(dir, 'clip.mp4')
    imagePath = join(dir, 'still.png')
    audioPath = join(dir, 'tone.mp3')
    const ff = ffmpegBinary()
    await execFileAsync(ff, [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-shortest', '-pix_fmt', 'yuv420p', videoPath
    ])
    await execFileAsync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=200x100:duration=1', '-frames:v', '1', imagePath])
    await execFileAsync(ff, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=1', audioPath])
  }, 60_000)

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  function project(): MediaManifest {
    return makeManifest({
      entries: [
        { id: 'vid', name: 'clip.mp4', type: 'video', source: { type: 'external', absolutePath: videoPath }, duration: 2 },
        { id: 'pic', name: 'still.png', type: 'image', source: { type: 'external', absolutePath: imagePath }, duration: 5 },
        { id: 'aud', name: 'tone.mp3', type: 'audio', source: { type: 'external', absolutePath: audioPath }, duration: 1 }
      ]
    })
  }

  it('renders a 3-track project (video + image PIP + audio) to a playable mp4', async () => {
    const manifest = project()
    // PIP image: 40% size, upper-right.
    const pip = makeClip({ id: 'PIP', mediaRef: 'pic', mediaType: 'image', startFrame: 15, durationFrames: 30 })
    pip.transform = { centerX: 0.78, centerY: 0.22, width: 0.4, height: 0.4, rotation: 0, flipHorizontal: false, flipVertical: false }

    const timeline = makeTimeline({
      fps: 30,
      width: 640,
      height: 360,
      tracks: [
        makeTrack({ type: 'video', clips: [pip] }), // top track (foreground)
        makeTrack({ type: 'video', clips: [makeClip({ id: 'BG', mediaRef: 'vid', startFrame: 0, durationFrames: 60 })] }),
        makeTrack({ type: 'audio', clips: [makeClip({ id: 'AUD', mediaRef: 'aud', mediaType: 'audio', startFrame: 0, durationFrames: 30 })] })
      ]
    })

    const outputPath = join(dir, 'out.mp4')
    const res = await exportTimeline({ timeline, manifest, projectDir: null, outputPath })
    expect(res.ok, res.error).toBe(true)

    const stat = await fs.stat(outputPath)
    expect(stat.size).toBeGreaterThan(1000)

    const probe = (await runFfprobeJson([
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', outputPath
    ])) as { format?: { duration?: string }; streams?: { codec_type?: string }[] }

    const duration = Number(probe.format?.duration ?? 0)
    expect(duration).toBeGreaterThan(1.7)
    expect(duration).toBeLessThan(2.4)
    const kinds = (probe.streams ?? []).map((s) => s.codec_type)
    expect(kinds).toContain('video')
    expect(kinds).toContain('audio')
  }, 120_000)

  it('refuses an empty timeline', async () => {
    const res = await exportTimeline({
      timeline: makeTimeline(),
      manifest: makeManifest(),
      projectDir: null,
      outputPath: join(dir, 'empty.mp4')
    })
    expect(res.ok).toBe(false)
  })
})
