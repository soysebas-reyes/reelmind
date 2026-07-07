// SPDX-License-Identifier: GPL-3.0-or-later
// Bake command: the ffmpeg arg vector for one baked media file.

import { describe, expect, it } from 'vitest'
import { makeAudioEnhance } from '../model/audioEnhance'
import { makeColorAdjustments } from '../model/color'
import { type BakeCommandSpec, buildBakeCommand } from './bakeCommand'

function spec(over: Partial<BakeCommandSpec> = {}): BakeCommandSpec {
  return {
    inputPath: 'C:/media/cam.mp4',
    outputPath: 'C:/out/cam__x.mp4',
    mode: 'source',
    mediaType: 'video',
    fps: 30,
    inFrame: 0,
    outFrame: 60,
    flipH: false,
    flipV: false,
    speed: 1,
    hasAudio: true,
    ...over
  }
}
function fc(args: string[]): string {
  const i = args.indexOf('-filter_complex')
  return i >= 0 ? args[i + 1] : ''
}

describe('buildBakeCommand', () => {
  it('bakes a color grade into the video via buildColorFilterChain', () => {
    const { args } = buildBakeCommand(spec({ color: makeColorAdjustments({ saturation: 1.5 }) }))
    expect(fc(args)).toContain('saturation=1.5')
    expect(fc(args)).toContain('[vout]')
    expect(args).toContain('-map')
    expect(args[args.length - 1]).toBe('C:/out/cam__x.mp4')
  })

  it('bakes the audio enhancement chain and maps [aout]', () => {
    const { args } = buildBakeCommand(spec({ audioEnhance: makeAudioEnhance({ enabled: true }) }))
    expect(fc(args)).toContain('acompressor')
    expect(fc(args)).toContain('loudnorm')
    expect(fc(args)).toContain('[aout]')
    const mapCount = args.filter((a) => a === '[aout]').length
    expect(mapCount).toBeGreaterThanOrEqual(1)
    expect(args).toContain('aac')
  })

  it('trims to the used window with the trim/atrim filters (no input -ss)', () => {
    const { args } = buildBakeCommand(spec({ inFrame: 30, outFrame: 90 }))
    expect(args).not.toContain('-ss')
    expect(fc(args)).toContain('trim=start_frame=30:end_frame=90')
    expect(fc(args)).toContain('atrim=start=1:end=3')
  })

  it('bakes speed in (setpts + atempo) so the NLE plays 1:1', () => {
    const { args, durationSeconds } = buildBakeCommand(spec({ mode: 'clip', speed: 2, inFrame: 0, outFrame: 120 }))
    expect(fc(args)).toContain('setpts=(PTS-STARTPTS)/2')
    expect(fc(args)).toContain('atempo=2')
    // 120 source frames / 30fps / speed 2 = 2s output
    expect(durationSeconds).toBeCloseTo(2, 6)
  })

  it('bakes flips into the pixels', () => {
    const { args } = buildBakeCommand(spec({ flipH: true, flipV: true }))
    expect(fc(args)).toContain('hflip')
    expect(fc(args)).toContain('vflip')
  })

  it('renders a single still for an image bake (no trim, one frame, png)', () => {
    const { args } = buildBakeCommand(
      spec({ mode: 'image', mediaType: 'image', hasAudio: false, color: makeColorAdjustments({ contrast: 1.2 }) })
    )
    expect(args).toContain('-frames:v')
    expect(args).toContain('png')
    expect(fc(args)).not.toContain('trim=')
    expect(args).not.toContain('[aout]')
  })

  it('omits the video map for an audio-only source', () => {
    const { args } = buildBakeCommand(spec({ mediaType: 'audio', audioEnhance: makeAudioEnhance({ enabled: true }) }))
    expect(fc(args)).not.toContain('[vout]')
    expect(fc(args)).toContain('[aout]')
    expect(args).not.toContain('libx264')
  })
})
