// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { proxyEncodeArgs, proxyScaleFilter } from './encoders'

describe('proxyScaleFilter', () => {
  it('forces LIMITED color range (out_range=tv) on every encoder path', () => {
    // Full-range yuvj420p from the hardware paths renders black in Chromium's <video> — the filter
    // graph must convert to limited range regardless of encoder.
    for (const enc of ['libx264', 'h264_amf', 'h264_nvenc', 'h264_qsv'] as const) {
      expect(proxyScaleFilter(enc, 720)).toContain('out_range=tv')
    }
  })
  it('feeds nv12 to hardware encoders and yuv420p to libx264', () => {
    expect(proxyScaleFilter('h264_amf', 720)).toContain('format=nv12')
    expect(proxyScaleFilter('libx264', 720)).toContain('format=yuv420p')
  })
  it('downscales on the given height', () => {
    expect(proxyScaleFilter('libx264', 720)).toContain('scale=-2:720')
  })
})

describe('proxyEncodeArgs', () => {
  it('selects the matching encoder', () => {
    expect(proxyEncodeArgs('h264_amf')).toContain('h264_amf')
    expect(proxyEncodeArgs('libx264')).toContain('libx264')
  })
})
