// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { exportEncodeArgs, proxyEncodeArgs, proxyScaleFilter } from './encoders'

describe('proxyScaleFilter', () => {
  it('forces LIMITED color range (out_range=tv) on every encoder path', () => {
    // Full-range yuvj420p from the hardware paths renders black in Chromium's <video> — the filter
    // graph must convert to limited range regardless of encoder.
    for (const enc of ['libx264', 'h264_amf', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox'] as const) {
      expect(proxyScaleFilter(enc, 720)).toContain('out_range=tv')
    }
  })
  it('feeds nv12 to hardware encoders and yuv420p to libx264', () => {
    expect(proxyScaleFilter('h264_amf', 720)).toContain('format=nv12')
    expect(proxyScaleFilter('h264_videotoolbox', 720)).toContain('format=nv12')
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
    expect(proxyEncodeArgs('h264_videotoolbox')).toContain('h264_videotoolbox')
  })
  it('uses VideoToolbox rate control (-q:v), never the PC flags it rejects', () => {
    const args = proxyEncodeArgs('h264_videotoolbox')
    expect(args).toContain('-q:v')
    for (const rejected of ['-qp', '-cq', '-global_quality', '-crf']) {
      expect(args).not.toContain(rejected)
    }
  })
})

describe('exportEncodeArgs', () => {
  it('keeps the max tier on libx264 CRF regardless of hardware encoder', () => {
    expect(exportEncodeArgs('h264_videotoolbox', 'max')).toContain('libx264')
  })
  it('maps export tiers to the VideoToolbox 1-100 quality scale', () => {
    const high = exportEncodeArgs('h264_videotoolbox', 'high')
    const veryHigh = exportEncodeArgs('h264_videotoolbox', 'veryHigh')
    expect(high).toContain('h264_videotoolbox')
    expect(high[high.indexOf('-q:v') + 1]).toBe('60')
    expect(veryHigh[veryHigh.indexOf('-q:v') + 1]).toBe('72')
    for (const rejected of ['-qp', '-cq', '-global_quality', '-crf']) {
      expect(high).not.toContain(rejected)
    }
  })
})
