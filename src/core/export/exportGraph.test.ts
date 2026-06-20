// SPDX-License-Identifier: GPL-3.0-or-later
// Export-graph builder: deterministic structure of the ffmpeg arg vector / filter_complex.

import { describe, expect, it } from 'vitest'
import { makeClip, makeTimeline, makeTrack } from '../model/timeline'
import { atempoFilters, buildExportGraph } from './exportGraph'

const resolve = (ref: string): string | null => (ref === 'missing' ? null : `C:/media/${ref}.mp4`)

function videoTrack(id: string, clips = [] as ReturnType<typeof makeClip>[]) {
  return makeTrack({ id, type: 'video', clips })
}
function audioTrack(id: string, clips = [] as ReturnType<typeof makeClip>[]) {
  return makeTrack({ id, type: 'audio', clips })
}

describe('buildExportGraph', () => {
  it('returns null for an empty timeline', () => {
    expect(buildExportGraph(makeTimeline(), resolve, 'out.mp4')).toBeNull()
  })

  it('renders a single full-frame video clip to a base + overlay + vout', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, width: 1920, height: 1080, tracks: [videoTrack('v', [clip])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g).not.toBeNull()
    expect(g.inputCount).toBe(1)
    expect(g.hasAudio).toBe(false)
    expect(g.durationSeconds).toBeCloseTo(2, 6)
    expect(g.filterComplex).toContain('color=c=black:s=1920x1080:r=30:d=2[base]')
    expect(g.filterComplex).toContain('scale=1920:1080')
    expect(g.filterComplex).toContain('[base][v0]overlay=x=0:y=0')
    expect(g.filterComplex).toContain("enable='between(t,0,2)'")
    expect(g.filterComplex).toContain('[vout]')
    expect(g.args).toContain('-filter_complex')
    expect(g.args).toContain('-map')
    expect(g.args).toContain('[vout]')
    expect(g.args[g.args.length - 1]).toBe('out.mp4')
    expect(g.args).not.toContain('[aout]')
  })

  it('seeks video inputs by trim and scales source duration by speed', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60, trimStartFrame: 30, speed: 2 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [clip])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    // -ss 1 (30/30), -t 4 (60*2/30)
    const ss = g.args.indexOf('-ss')
    expect(ss).toBeGreaterThan(-1)
    expect(g.args[ss + 1]).toBe('1')
    const t = g.args.indexOf('-t')
    expect(g.args[t + 1]).toBe('4')
    expect(g.filterComplex).toContain('setpts=(PTS-STARTPTS)/2+0/TB')
  })

  it('loops images for their on-timeline duration', () => {
    const img = makeClip({ id: 'I', mediaRef: 'pic', mediaType: 'image', startFrame: 0, durationFrames: 90 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [img])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.args).toContain('-loop')
    expect(g.args).toContain('1')
  })

  it('emits crop, opacity, and fade filters when set', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    clip.opacity = 0.5
    clip.fadeInFrames = 15
    clip.fadeOutFrames = 15
    clip.crop = { left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 }
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [clip])] })
    const fc = buildExportGraph(tl, resolve, 'out.mp4')!.filterComplex
    expect(fc).toContain('crop=iw*0.8:ih*0.8:iw*0.1:ih*0.1')
    expect(fc).toContain('colorchannelmixer=aa=0.5')
    expect(fc).toContain('fade=t=in:st=0:d=0.5:alpha=1')
    expect(fc).toContain('fade=t=out:st=1.5:d=0.5:alpha=1')
  })

  it('overlays in back-to-front order (top track last)', () => {
    const fg = makeClip({ id: 'FG', mediaRef: 'fg', startFrame: 0, durationFrames: 60 })
    const bg = makeClip({ id: 'BG', mediaRef: 'bg', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('top', [fg]), videoTrack('bottom', [bg])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    // input 0 = background (bottom track), input 1 = foreground (top track)
    const fc = g.filterComplex
    const bgOverlay = fc.indexOf('[base][v0]overlay')
    const fgOverlay = fc.indexOf('[ov0][v1]overlay')
    expect(bgOverlay).toBeGreaterThan(-1)
    expect(fgOverlay).toBeGreaterThan(bgOverlay)
  })

  it('mixes audio with delay and volume, and maps an audio output', () => {
    const v = makeClip({ id: 'V', mediaRef: 'v', startFrame: 0, durationFrames: 90 })
    const a1 = makeClip({ id: 'A1', mediaRef: 'a1', mediaType: 'audio', startFrame: 0, durationFrames: 30, volume: 0.5 })
    const a2 = makeClip({ id: 'A2', mediaRef: 'a2', mediaType: 'audio', startFrame: 30, durationFrames: 30 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [v]), audioTrack('a', [a1, a2])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.hasAudio).toBe(true)
    expect(g.filterComplex).toContain('volume=0.5')
    expect(g.filterComplex).toContain('adelay=1000:all=1') // a2 at frame 30 → 1000ms
    expect(g.filterComplex).toContain('amix=inputs=2:normalize=0')
    expect(g.args).toContain('[aout]')
    expect(g.args).toContain('-c:a')
  })

  it('skips clips whose media cannot be resolved', () => {
    const ok = makeClip({ id: 'OK', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    const gone = makeClip({ id: 'GONE', mediaRef: 'missing', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [ok, gone])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.inputCount).toBe(1)
  })
})

describe('atempoFilters', () => {
  const product = (fs: string[]) => fs.reduce((p, f) => p * Number(f.split('=')[1]), 1)
  const allInRange = (fs: string[]) => fs.every((f) => {
    const v = Number(f.split('=')[1])
    return v >= 0.5 - 1e-9 && v <= 2.0 + 1e-9
  })

  it('passes 1.0 through as no filter', () => {
    expect(atempoFilters(1)).toEqual([])
  })
  it('keeps in-range factors as a single filter', () => {
    expect(atempoFilters(1.5)).toEqual(['atempo=1.5'])
    expect(atempoFilters(0.75)).toEqual(['atempo=0.75'])
  })
  it('chains factors outside [0.5, 2.0] so each is valid and the product matches', () => {
    for (const speed of [4, 0.25, 3, 8, 0.1]) {
      const fs = atempoFilters(speed)
      expect(allInRange(fs)).toBe(true)
      expect(product(fs)).toBeCloseTo(speed, 6)
    }
  })
})
