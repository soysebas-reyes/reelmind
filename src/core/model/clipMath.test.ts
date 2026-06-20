// SPDX-License-Identifier: GPL-3.0-or-later
// Golden tests ported from palmier-pro Tests/.../Timeline/ClipMathTests.swift

import { describe, expect, it } from 'vitest'
import { fxAudioTrack, fxClip, fxTimeline, fxVideoTrack } from '../testing/fixtures'
import { keyframe } from './keyframe'
import {
  clipContains,
  clipEndFrame,
  fadeMultiplier,
  opacityAt,
  rawOpacityAt,
  sourceDurationFrames,
  sourceFramesConsumed,
  timelineFrameForSourceSeconds,
  totalFrames,
  volumeAt
} from './timeline'

describe('Clip math — frame/source math', () => {
  it('endFrame is start plus duration', () => {
    expect(clipEndFrame(fxClip({ start: 100, duration: 50 }))).toBe(150)
  })

  it('sourceFramesConsumed scales by speed', () => {
    expect(sourceFramesConsumed(fxClip({ start: 0, duration: 100, speed: 2.0 }))).toBe(200)
  })

  it('sourceFramesConsumed rounds for fractional speed', () => {
    expect(sourceFramesConsumed(fxClip({ start: 0, duration: 33, speed: 0.75 }))).toBe(25)
  })

  it('sourceDuration includes both trims', () => {
    expect(sourceDurationFrames(fxClip({ start: 0, duration: 100, trimStart: 10, trimEnd: 5 }))).toBe(115)
  })
})

describe('Clip math — contains (half-open)', () => {
  it('is half-open [start, end)', () => {
    const clip = fxClip({ start: 50, duration: 30 }) // endFrame 80
    expect(clipContains(clip, 50)).toBe(true)
    expect(clipContains(clip, 79)).toBe(true)
    expect(clipContains(clip, 80)).toBe(false)
    expect(clipContains(clip, 49)).toBe(false)
  })
})

describe('Clip math — timelineFrame(sourceSeconds)', () => {
  it('maps source seconds through trim', () => {
    const clip = fxClip({ start: 100, duration: 60, trimStart: 30 })
    expect(timelineFrameForSourceSeconds(clip, 2.0, 30)).toBe(130)
  })

  it('divides by speed', () => {
    const clip = fxClip({ start: 0, duration: 100, speed: 2.0 })
    expect(timelineFrameForSourceSeconds(clip, 2.0, 30)).toBe(30)
  })

  it('before trim returns null', () => {
    const clip = fxClip({ start: 100, duration: 60, trimStart: 30 })
    expect(timelineFrameForSourceSeconds(clip, 0.5, 30)).toBeNull()
  })

  it('at or past endFrame returns null', () => {
    const clip = fxClip({ start: 0, duration: 30 })
    expect(timelineFrameForSourceSeconds(clip, 1.0, 30)).toBeNull()
    expect(timelineFrameForSourceSeconds(clip, 2.0, 30)).toBeNull()
  })
})

describe('Clip math — fadeMultiplier', () => {
  it('is one everywhere with no fades', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    expect(fadeMultiplier(clip, 0)).toBe(1.0)
    expect(fadeMultiplier(clip, 50)).toBe(1.0)
    expect(fadeMultiplier(clip, 100)).toBe(1.0)
  })

  it('is zero outside clip range', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.fadeInFrames = 10
    expect(fadeMultiplier(clip, -1)).toBe(0)
    expect(fadeMultiplier(clip, 101)).toBe(0)
  })

  it('linear fade-in ramps zero to one', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'linear'
    expect(fadeMultiplier(clip, 0)).toBe(0)
    expect(fadeMultiplier(clip, 5)).toBe(0.5)
    expect(fadeMultiplier(clip, 10)).toBe(1.0)
    expect(fadeMultiplier(clip, 50)).toBe(1.0)
  })

  it('smooth fade-in uses smoothstep', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'smooth'
    expect(fadeMultiplier(clip, 0)).toBe(0)
    expect(fadeMultiplier(clip, 5)).toBe(0.5)
    expect(fadeMultiplier(clip, 10)).toBe(1.0)
  })

  it('combined fades take minimum of in and out', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.fadeInFrames = 20
    clip.fadeOutFrames = 20
    expect(fadeMultiplier(clip, 0)).toBe(0)
    expect(fadeMultiplier(clip, 100)).toBe(0)
    expect(fadeMultiplier(clip, 50)).toBe(1.0)
  })
})

describe('Clip math — volume / opacity', () => {
  it('volumeAt returns static volume without fade or kfs', () => {
    expect(volumeAt(fxClip({ start: 0, duration: 100, volume: 0.5 }), 50)).toBe(0.5)
  })

  it('volumeAt multiplies static volume by fade', () => {
    const clip = fxClip({ start: 0, duration: 100, volume: 0.5 })
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'linear'
    expect(Math.abs(volumeAt(clip, 5) - 0.25)).toBeLessThan(1e-9)
  })

  it('opacityAt returns static opacity without fade', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.opacity = 0.5
    expect(opacityAt(clip, 50)).toBe(0.5)
  })

  it('opacityAt multiplies static opacity by fade', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.opacity = 0.5
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'linear'
    expect(Math.abs(opacityAt(clip, 5) - 0.25)).toBeLessThan(1e-9)
  })

  it('opacityAt multiplies keyframed opacity by fade', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.opacity = 1.0
    clip.opacityTrack = { keyframes: [keyframe(0, 0.4), keyframe(100, 0.4)] }
    clip.fadeOutFrames = 20
    clip.fadeOutInterpolation = 'linear'
    expect(Math.abs(opacityAt(clip, 90) - 0.2)).toBeLessThan(1e-9)
  })

  it('opacityAt ignores fade for audio clips', () => {
    const clip = fxClip({ mediaType: 'audio', start: 0, duration: 100 })
    clip.opacity = 1.0
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'linear'
    expect(opacityAt(clip, 5)).toBe(1.0)
  })

  it('rawOpacityAt ignores fade', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    clip.opacity = 1.0
    clip.fadeInFrames = 10
    clip.fadeInInterpolation = 'linear'
    expect(rawOpacityAt(clip, 0)).toBe(1.0)
    expect(rawOpacityAt(clip, 5)).toBe(1.0)
    expect(opacityAt(clip, 5)).toBe(0.5)
  })
})

describe('Clip math — adversarial', () => {
  it('endFrame is exclusive', () => {
    expect(clipContains(fxClip({ start: 0, duration: 30 }), 30)).toBe(false)
  })

  it('contains and timelineFrame agree at endFrame (both exclude)', () => {
    const clip = fxClip({ start: 0, duration: 30 })
    expect(clipContains(clip, 30)).toBe(false)
    expect(timelineFrameForSourceSeconds(clip, 1.0, 30)).toBeNull()
  })

  it('zero-duration clip does not crash fadeMultiplier', () => {
    const clip = fxClip({ start: 0, duration: 0 })
    clip.fadeInFrames = 5
    clip.fadeInInterpolation = 'linear'
    expect(() => {
      fadeMultiplier(clip, 0)
      fadeMultiplier(clip, -1)
      fadeMultiplier(clip, 1)
    }).not.toThrow()
  })

  it('zero speed does not divide by zero in timelineFrame', () => {
    const clip = fxClip({ start: 0, duration: 100, speed: 0 })
    expect(() => timelineFrameForSourceSeconds(clip, 1.0, 30)).not.toThrow()
  })

  it('negative start frame produces negative end frame', () => {
    const clip = fxClip({ start: -50, duration: 30 })
    expect(clipEndFrame(clip)).toBe(-20)
    expect(clipContains(clip, -40)).toBe(true)
    expect(clipContains(clip, 0)).toBe(false)
  })
})

describe('Timeline — invariants', () => {
  it('totalFrames equals maximum track end frame', () => {
    const timeline = fxTimeline({
      tracks: [
        fxVideoTrack({ clips: [fxClip({ start: 0, duration: 50 })] }),
        fxAudioTrack({ clips: [fxClip({ start: 100, duration: 80 })] })
      ]
    })
    expect(totalFrames(timeline)).toBe(180)
  })

  it('empty timeline has zero total frames', () => {
    expect(totalFrames(fxTimeline({ tracks: [] }))).toBe(0)
  })
})
