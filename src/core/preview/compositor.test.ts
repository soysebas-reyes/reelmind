// SPDX-License-Identifier: GPL-3.0-or-later
// Frame compositor: visibility, z-order, fade opacity, audio gain, and source-time mapping.

import { describe, expect, it } from 'vitest'
import { makeClip, makeTimeline, makeTrack } from '../model/timeline'
import { clipSourceSecondsAt, composeFrame, layerFullyOccludes, visibleLayerSet } from './compositor'

function videoTrack(id: string, clips = [] as ReturnType<typeof makeClip>[]) {
  return makeTrack({ id, type: 'video', clips })
}
function audioTrack(id: string, clips = [] as ReturnType<typeof makeClip>[]) {
  return makeTrack({ id, type: 'audio', clips })
}

describe('composeFrame', () => {
  it('returns only clips that contain the frame', () => {
    const a = makeClip({ id: 'A', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    const b = makeClip({ id: 'B', mediaRef: 'm', startFrame: 200, durationFrames: 100 })
    const tl = makeTimeline({ tracks: [videoTrack('v', [a, b])] })
    expect(composeFrame(tl, 50).visual.map((l) => l.clipId)).toEqual(['A'])
    expect(composeFrame(tl, 250).visual.map((l) => l.clipId)).toEqual(['B'])
    expect(composeFrame(tl, 150).visual).toHaveLength(0)
  })

  it('orders layers back-to-front with the top track (index 0) on top', () => {
    const fg = makeClip({ id: 'FG', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    const bg = makeClip({ id: 'BG', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    const tl = makeTimeline({ tracks: [videoTrack('top', [fg]), videoTrack('bottom', [bg])] })
    // Draw order: background first, foreground last.
    expect(composeFrame(tl, 50).visual.map((l) => l.clipId)).toEqual(['BG', 'FG'])
  })

  it('skips hidden visual tracks and muted audio tracks', () => {
    const v = makeClip({ id: 'V', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    const aud = makeClip({ id: 'AUD', mediaRef: 'm', mediaType: 'audio', startFrame: 0, durationFrames: 100 })
    const vt = videoTrack('v', [v])
    vt.hidden = true
    const at = audioTrack('a', [aud])
    at.muted = true
    const tl = makeTimeline({ tracks: [vt, at] })
    const f = composeFrame(tl, 50)
    expect(f.visual).toHaveLength(0)
    expect(f.audio).toHaveLength(0)
  })

  it('applies the fade-in envelope to layer opacity', () => {
    const c = makeClip({ id: 'C', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    c.fadeInFrames = 10
    const tl = makeTimeline({ tracks: [videoTrack('v', [c])] })
    expect(composeFrame(tl, 5).visual[0].opacity).toBeCloseTo(0.5, 5)
    expect(composeFrame(tl, 50).visual[0].opacity).toBeCloseTo(1, 5)
  })

  it('reports effective audio gain and skips fully transparent visual layers', () => {
    const aud = makeClip({ id: 'AUD', mediaRef: 'm', mediaType: 'audio', startFrame: 0, durationFrames: 100, volume: 0.5 })
    const ghost = makeClip({ id: 'G', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    ghost.opacity = 0
    const tl = makeTimeline({ tracks: [videoTrack('v', [ghost]), audioTrack('a', [aud])] })
    const f = composeFrame(tl, 50)
    expect(f.visual).toHaveLength(0) // opacity 0 → dropped
    expect(f.audio).toHaveLength(1)
    expect(f.audio[0].gain).toBeCloseTo(0.5, 5)
  })

  it('maps a frame to source seconds through trim and speed', () => {
    const c = makeClip({ id: 'C', mediaRef: 'm', startFrame: 30, durationFrames: 100, trimStartFrame: 15, speed: 2 })
    // sourceFrame = 15 + (45-30)*2 = 45; /30fps = 1.5s
    expect(clipSourceSecondsAt(c, 45, 30)).toBeCloseTo(1.5, 6)
    const tl = makeTimeline({ fps: 30, tracks: [videoTrack('v', [c])] })
    expect(composeFrame(tl, 45).visual[0].sourceSeconds).toBeCloseTo(1.5, 6)
  })
})

describe('visibleLayerSet (occlusion culling for playback)', () => {
  const stack = (mutate?: (c: ReturnType<typeof makeClip>) => void) => {
    const frontal = makeClip({ id: 'F', mediaRef: 'frontal', startFrame: 0, durationFrames: 100 })
    const lateral = makeClip({ id: 'L', mediaRef: 'lateral', startFrame: 0, durationFrames: 100 })
    mutate?.(frontal)
    // top track (index 0) = frontal on top, lateral below — the synced multicam stack.
    return makeTimeline({ tracks: [videoTrack('top', [frontal]), videoTrack('bot', [lateral])] })
  }

  it('keeps only the top angle when it fully covers the one below', () => {
    const set = visibleLayerSet(composeFrame(stack(), 50).visual)
    expect(set.has('frontal')).toBe(true)
    expect(set.has('lateral')).toBe(false)
  })

  it('keeps both when the top layer is partially transparent (mid fade-in)', () => {
    const tl = stack((c) => {
      c.fadeInFrames = 20
    })
    const set = visibleLayerSet(composeFrame(tl, 5).visual) // opacity < 1
    expect(set.has('frontal')).toBe(true)
    expect(set.has('lateral')).toBe(true)
  })

  it('keeps both when the top layer is scaled to a PiP (not full-frame)', () => {
    const tl = stack((c) => {
      c.transform = { ...c.transform, width: 0.4, height: 0.4 }
    })
    const set = visibleLayerSet(composeFrame(tl, 50).visual)
    expect(set.has('frontal')).toBe(true)
    expect(set.has('lateral')).toBe(true)
  })

  it('layerFullyOccludes is true for a default full-frame opaque layer', () => {
    const c = makeClip({ id: 'C', mediaRef: 'm', startFrame: 0, durationFrames: 100 })
    const layer = composeFrame(makeTimeline({ tracks: [videoTrack('v', [c])] }), 50).visual[0]
    expect(layerFullyOccludes(layer)).toBe(true)
  })
})
