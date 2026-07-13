// SPDX-License-Identifier: GPL-3.0-or-later
// Integration test: run a full NLE handoff with real FFmpeg — bake graded media + write the xmeml, then
// verify the folder layout, that the XML references real files, and that ungraded sources are referenced
// (not baked). Self-skips if ffmpeg/ffprobe are absent.

import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type MediaManifest, makeClip, makeColorAdjustments, makeManifest, makeTimeline, makeTrack } from '@core'
import { checkFfmpeg, ffmpegBinary } from '../ffmpeg'
import { runHandoff } from './handoff'

const execFileAsync = promisify(execFile)
const status = await checkFfmpeg()
const haveFfmpeg = status.ffmpeg && status.ffprobe

let dir = ''
let videoPath = ''

describe.skipIf(!haveFfmpeg)('NLE handoff (integration, requires ffmpeg)', () => {
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'reelo-handoff-'))
    videoPath = join(dir, 'cam.mp4')
    await execFileAsync(ffmpegBinary(), [
      '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-shortest', '-pix_fmt', 'yuv420p', videoPath
    ])
  }, 60_000)

  afterAll(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  function manifestOf(): MediaManifest {
    return makeManifest({
      entries: [
        {
          id: 'cam',
          name: 'cam.mp4',
          type: 'video',
          source: { type: 'external', absolutePath: videoPath },
          duration: 3,
          sourceWidth: 320,
          sourceHeight: 240,
          hasAudio: true
        }
      ]
    })
  }

  it('bakes a graded source and writes an editable xmeml referencing the baked media', async () => {
    const manifest = manifestOf()
    const clip = { ...makeClip({ id: 'A', mediaRef: 'cam', startFrame: 0, durationFrames: 60 }), color: makeColorAdjustments({ saturation: 1.6 }) }
    const timeline = makeTimeline({ fps: 30, width: 320, height: 240, tracks: [makeTrack({ type: 'video', clips: [clip] })] })

    const res = await runHandoff({ timeline, manifest, projectDir: null, projectName: 'Prueba', outDir: dir, target: 'universal' })
    expect(res.ok, res.error).toBe(true)
    expect(res.bakedCount).toBe(1)
    expect(res.referencedCount).toBe(0)
    expect(res.clipItemCount).toBe(2) // 1 video + 1 linked audio

    // Folder layout.
    const media = await fs.readdir(join(res.folder!, 'media'))
    expect(media.filter((f) => f.endsWith('.mp4')).length).toBe(1)

    // XML is well-formed xmeml and points at a real file inside the package.
    const xml = await fs.readFile(res.xmlPath!, 'utf8')
    expect(xml).toContain('<!DOCTYPE xmeml>')
    expect(xml).toContain('<xmeml version="5">')
    const m = /<pathurl>([^<]+)<\/pathurl>/.exec(xml)
    expect(m).toBeTruthy()
    // file URL → filesystem path, per-platform: win drops the leading slash and uses backslashes
    // (file:///C:/x → C:\x); POSIX keeps the leading slash (file:///var/x → /var/x).
    const decoded = decodeURIComponent(m![1].replace(/^file:\/\//, ''))
    const filePath =
      process.platform === 'win32' ? decoded.replace(/^\/+/, '').replace(/\//g, '\\') : decoded
    // The referenced media lives in the handoff's media/ dir.
    expect(m![1]).toContain('/media/')
    await expect(fs.stat(filePath)).resolves.toBeTruthy()

    // README is present.
    await expect(fs.stat(join(res.folder!, 'README.txt'))).resolves.toBeTruthy()
  }, 120_000)

  it('writes a CapCut draft (draft_content + draft_meta_info) referencing baked media', async () => {
    const manifest = manifestOf()
    const clip = { ...makeClip({ id: 'A', mediaRef: 'cam', startFrame: 0, durationFrames: 60 }), color: makeColorAdjustments({ saturation: 1.6 }) }
    const timeline = makeTimeline({ fps: 30, width: 320, height: 240, tracks: [makeTrack({ type: 'video', clips: [clip] })] })

    const res = await runHandoff({ timeline, manifest, projectDir: null, projectName: 'CapCut', outDir: dir, target: 'capcut' })
    expect(res.ok, res.error).toBe(true)
    expect(res.isCapCut).toBe(true)
    expect(res.bakedCount).toBe(1)
    expect(res.clipItemCount).toBe(1) // one segment; the video segment carries its own audio

    // The draft folder is a DIRECT child of outDir (so CapCut lists it), no `handoff/` wrapper, no .xml.
    expect(res.xmlPath).toBeUndefined()
    const media = await fs.readdir(join(res.folder!, 'media'))
    expect(media.filter((f) => f.endsWith('.mp4')).length).toBe(1)

    const content = JSON.parse(await fs.readFile(join(res.folder!, 'draft_content.json'), 'utf8'))
    expect(content.materials.videos).toHaveLength(1)
    expect(content.materials.videos[0].path).toContain('/media/')
    expect(content.tracks[0].segments).toHaveLength(1)
    expect(content.tracks[0].segments[0].target_timerange.duration).toBe(2_000_000)
    // The referenced baked file actually exists on disk.
    await expect(fs.stat(content.materials.videos[0].path)).resolves.toBeTruthy()

    const meta = JSON.parse(await fs.readFile(join(res.folder!, 'draft_meta_info.json'), 'utf8'))
    expect(meta.draft_name).toBe(res.folder!.replace(/\\/g, '/').split('/').pop())
    const mediaList = meta.draft_materials.find((m: { type: number }) => m.type === 0)
    expect(mediaList.value).toHaveLength(1)

    await expect(fs.stat(join(res.folder!, 'README.txt'))).resolves.toBeTruthy()
  }, 120_000)

  it('references the original (no bake) when the source needs no grade or enhancement', async () => {
    const manifest = manifestOf()
    const clip = makeClip({ id: 'A', mediaRef: 'cam', startFrame: 0, durationFrames: 60 })
    const timeline = makeTimeline({ fps: 30, width: 320, height: 240, tracks: [makeTrack({ type: 'video', clips: [clip] })] })

    const res = await runHandoff({ timeline, manifest, projectDir: null, projectName: 'Raw', outDir: dir, target: 'universal' })
    expect(res.ok, res.error).toBe(true)
    expect(res.bakedCount).toBe(0)
    expect(res.referencedCount).toBe(1)
    const xml = await fs.readFile(res.xmlPath!, 'utf8')
    // pathurl points at the original source, not a baked copy.
    expect(xml).toContain('cam.mp4')
    expect(xml).not.toContain('/media/')
  }, 120_000)

  it('fails cleanly on an empty timeline', async () => {
    const res = await runHandoff({
      timeline: makeTimeline(),
      manifest: makeManifest(),
      projectDir: null,
      projectName: 'Empty',
      outDir: dir,
      target: 'universal'
    })
    expect(res.ok).toBe(false)
  })
})
