// SPDX-License-Identifier: GPL-3.0-or-later
// Integration test for the real FFmpeg media pipeline. Generates synthetic media with ffmpeg
// (lavfi) and exercises probe → thumbnail → import. Self-skips if ffmpeg/ffprobe are absent.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkFfmpeg, ffmpegBinary, generateThumbnail, probeMedia } from '../ffmpeg'
import { importMedia } from './importer'

const execFileAsync = promisify(execFile)
const status = await checkFfmpeg()
const haveFfmpeg = status.ffmpeg && status.ffprobe

let dir = ''
let videoPath = ''
let imagePath = ''
let audioPath = ''

describe.skipIf(!haveFfmpeg)('media pipeline (integration, requires ffmpeg)', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'reelo-test-'))
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
    await execFileAsync(ff, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', audioPath])
  }, 60_000)

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  it('probes a video: duration, dimensions, fps, audio', async () => {
    const p = await probeMedia(videoPath)
    expect(p.hasVideo).toBe(true)
    expect(p.hasAudio).toBe(true)
    expect(p.width).toBe(320)
    expect(p.height).toBe(240)
    expect(Math.round(p.fps ?? 0)).toBe(30)
    expect(p.durationSeconds).toBeGreaterThan(1.5)
    expect(p.durationSeconds).toBeLessThan(2.6)
  })

  it('probes an audio file: audio only', async () => {
    const p = await probeMedia(audioPath)
    expect(p.hasAudio).toBe(true)
    expect(p.hasVideo).toBe(false)
  })

  it('generates a video thumbnail as a jpeg data URL', async () => {
    const thumb = await generateThumbnail(videoPath, { type: 'video', durationSeconds: 2 })
    expect(thumb).toMatch(/^data:image\/jpeg;base64,/)
    expect((thumb ?? '').length).toBeGreaterThan(100)
  })

  it('generates an audio waveform thumbnail as a png data URL', async () => {
    const thumb = await generateThumbnail(audioPath, { type: 'audio', durationSeconds: 1 })
    expect(thumb).toMatch(/^data:image\/png;base64,/)
  })

  it('imports mixed media into manifest entries', async () => {
    const imported = await importMedia([videoPath, imagePath, audioPath])
    expect(imported).toHaveLength(3)
    const byType = Object.fromEntries(imported.map((i) => [i.entry.type, i]))

    expect(byType.video.entry.source).toEqual({ type: 'external', absolutePath: videoPath })
    expect(byType.video.entry.sourceWidth).toBe(320)
    expect(byType.video.entry.hasAudio).toBe(true)
    expect(byType.video.thumbnail).toMatch(/^data:image\/jpeg/)

    expect(byType.image.entry.type).toBe('image')
    expect(byType.image.entry.sourceWidth).toBe(200)
    expect(byType.image.entry.duration).toBe(5) // image default duration

    expect(byType.audio.entry.type).toBe('audio')
    expect(byType.audio.entry.hasAudio).toBe(true)
  })
})
