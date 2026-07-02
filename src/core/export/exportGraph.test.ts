// SPDX-License-Identifier: GPL-3.0-or-later
// Export-graph builder: deterministic structure of the ffmpeg arg vector / filter_complex.

import { describe, expect, it } from 'vitest'
import { makeAudioEnhance } from '../model/audioEnhance'
import { makeColorAdjustments } from '../model/color'
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

  it('carves the source window with trim (start..end) and scales source duration by speed', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60, trimStartFrame: 30, speed: 2 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [clip])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    // One shared input (no per-clip -ss/-t); the window is a filter: trim start=1 (30/30) end=5 ((30+60*2)/30).
    expect(g.args).not.toContain('-ss')
    expect(g.filterComplex).toContain('trim=start=1:end=5')
    expect(g.filterComplex).toContain('setpts=(PTS-STARTPTS)/2+0/TB')
  })

  it('deduplicates inputs: many clips from the same source share ONE -i (split fan-out)', () => {
    // Two segments of the same source (as multicam cuts produce) → a single input + a split=2.
    const a1 = makeClip({ id: 'A1', mediaRef: 'cam', startFrame: 0, durationFrames: 30, trimStartFrame: 0 })
    const a2 = makeClip({ id: 'A2', mediaRef: 'cam', startFrame: 30, durationFrames: 30, trimStartFrame: 30 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [a1, a2])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.inputCount).toBe(1)
    expect((g.args.join(' ').match(/-i /g) ?? []).length).toBe(1)
    expect(g.filterComplex).toContain('[0:v]split=2')
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

  it('inserts the voice-enhance chain (FFmpeg) for an enabled audioEnhance clip', () => {
    const v = makeClip({ id: 'V', mediaRef: 'v', startFrame: 0, durationFrames: 30 })
    const a = makeClip({ id: 'A', mediaRef: 'a', mediaType: 'audio', startFrame: 0, durationFrames: 30 })
    a.audioEnhance = makeAudioEnhance({ enabled: true, highpassHz: 90, denoise: true, limiter: true, targetLufs: -16 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [v]), audioTrack('a', [a])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.filterComplex).toContain('highpass=f=90')
    expect(g.filterComplex).toContain('afftdn=')
    expect(g.filterComplex).toContain('acompressor=')
    expect(g.filterComplex).toContain('alimiter=')
    expect(g.filterComplex).toContain('loudnorm=I=-16')
  })

  it('skips the enhance chain when audioEnhance is disabled (identity → byte-identical render)', () => {
    const v = makeClip({ id: 'V', mediaRef: 'v', startFrame: 0, durationFrames: 30 })
    const a = makeClip({ id: 'A', mediaRef: 'a', mediaType: 'audio', startFrame: 0, durationFrames: 30 })
    a.audioEnhance = makeAudioEnhance({ enabled: false, highpassHz: 90 })
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [v]), audioTrack('a', [a])] })
    const g = buildExportGraph(tl, resolve, 'out.mp4')!
    expect(g.filterComplex).not.toContain('loudnorm')
    expect(g.filterComplex).not.toContain('acompressor')
  })
})

describe('buildExportGraph — color grading (P9.5)', () => {
  const lutResolver = (ref: string): string | null => (ref.includes('missing') ? null : 'C:/luts/look.cube')

  function gradedFc(color: ReturnType<typeof makeColorAdjustments>, resolveLut?: (ref: string) => string | null): string {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    clip.color = color
    const tl = makeTimeline({ fps: 30, width: 1920, height: 1080, tracks: [videoTrack('v', [clip])] })
    return buildExportGraph(tl, resolve, 'out.mp4', {}, resolveLut)!.filterComplex
  }

  it('emits no color filters for a neutral (identity) clip — byte-identical clip chain', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    clip.color = makeColorAdjustments() // identity
    const tl = makeTimeline({ fps: 30, width: 1920, height: 1080, tracks: [videoTrack('v', [clip])] })
    const fc = buildExportGraph(tl, resolve, 'out.mp4')!.filterComplex
    expect(fc).not.toContain('eq=')
    expect(fc).not.toContain('lut3d')
    expect(fc).not.toContain('curves=')
    expect(fc).not.toContain('[gin0]')
    expect(fc).toContain('[0:v]trim=start=0:end=2,scale=1920:1080,setsar=1,setpts=(PTS-STARTPTS)/1+0/TB,format=yuva420p[v0]')
  })

  it('emits eq + colorbalance + curves for a no-LUT grade', () => {
    const fc = gradedFc(
      makeColorAdjustments({ saturation: 0.88, contrast: 0.789, temperature: -7.4, tint: 4, shadows: 8.6 })
    )
    expect(fc).toContain('eq=contrast=0.789:saturation=0.88')
    expect(fc).toContain('colorbalance=')
    expect(fc).toContain("curves=all='0/0 0.25/0.293 1/1'")
    expect(fc).toContain('[gin0]')
    expect(fc).toContain('[gout0]')
    expect(fc).not.toContain('lut3d')
  })

  it('applies a full-intensity LUT inline (no split/blend)', () => {
    const fc = gradedFc(makeColorAdjustments({ lutRef: 'preset:x', lutIntensity: 1 }), lutResolver)
    expect(fc).toContain("lut3d=file='C\\:/luts/look.cube':interp=tetrahedral")
    expect(fc).not.toContain('split')
    expect(fc).not.toContain('blend=')
  })

  it('blends a partial-intensity LUT via split + blend, with grade after the blend', () => {
    const fc = gradedFc(makeColorAdjustments({ lutRef: 'preset:x', lutIntensity: 0.5, saturation: 0.88 }), lutResolver)
    expect(fc).toContain('split[gout0_a][gout0_b]')
    expect(fc).toContain("[gout0_b]lut3d=file='C\\:/luts/look.cube':interp=tetrahedral[gout0_l]")
    expect(fc).toContain("[gout0_l][gout0_a]blend=all_expr='A*0.5+B*0.5',eq=saturation=0.88[gout0]")
  })

  it('skips an unresolved LUT but still applies the grade (graceful)', () => {
    const fc = gradedFc(makeColorAdjustments({ lutRef: 'preset:missing', lutIntensity: 0.5, saturation: 0.88 }), lutResolver)
    expect(fc).not.toContain('lut3d')
    expect(fc).not.toContain('split')
    expect(fc).toContain('eq=saturation=0.88')
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
