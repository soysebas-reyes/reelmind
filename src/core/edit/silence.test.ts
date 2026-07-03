// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { makeClip } from '../model/timeline'
import { fxAudioTrack, fxClip, fxTimeline, fxVideoTrack } from '../testing/fixtures'
import { pickDefaultSilenceTarget, silencesToCuts } from './silence'

describe('silencesToCuts', () => {
  it('maps a source silence to a timeline cut (no trim, speed 1, 30fps)', () => {
    const clip = makeClip({ mediaRef: 'm', startFrame: 0, durationFrames: 300 }) // 0..10s
    const cuts = silencesToCuts(clip, [{ start: 2, end: 4 }], 30, { paddingSec: 0, minSilenceSec: 0 })
    expect(cuts).toEqual([{ startFrame: 60, endFrame: 120 }])
  })

  it('offsets by startFrame and trim', () => {
    // Placed at frame 100, trims 30 source frames (1s) off the head → shows source 1s..11s.
    const clip = makeClip({ mediaRef: 'm', startFrame: 100, durationFrames: 300, trimStartFrame: 30 })
    // source silence 2s..3s → source frames 60..90 → minus trim 30 → 30..60 → +start 100 → 130..160
    const cuts = silencesToCuts(clip, [{ start: 2, end: 3 }], 30, { paddingSec: 0, minSilenceSec: 0 })
    expect(cuts).toEqual([{ startFrame: 130, endFrame: 160 }])
  })

  it('accounts for speed (2x source maps to half the timeline span)', () => {
    const clip = makeClip({ mediaRef: 'm', startFrame: 0, durationFrames: 150, speed: 2 }) // shows 10s of source in 5s
    // source 2s..4s → frames 60..120 → /speed 2 → 30..60
    const cuts = silencesToCuts(clip, [{ start: 2, end: 4 }], 30, { paddingSec: 0, minSilenceSec: 0 })
    expect(cuts).toEqual([{ startFrame: 30, endFrame: 60 }])
  })

  it('applies padding and drops sub-minimum silences', () => {
    const clip = makeClip({ mediaRef: 'm', startFrame: 0, durationFrames: 300 })
    // 0.4s silence, 0.1s padding each side → 0.2s < 0.3s min → dropped
    expect(silencesToCuts(clip, [{ start: 2, end: 2.4 }], 30, { paddingSec: 0.1, minSilenceSec: 0.3 })).toEqual([])
  })

  it('clamps a silence that runs past the clip body (e.g. dangling Infinity end)', () => {
    const clip = makeClip({ mediaRef: 'm', startFrame: 0, durationFrames: 90 }) // 0..3s
    const cuts = silencesToCuts(clip, [{ start: 2, end: Number.POSITIVE_INFINITY }], 30, { paddingSec: 0, minSilenceSec: 0 })
    expect(cuts).toEqual([{ startFrame: 60, endFrame: 90 }])
  })

  it('sorts multiple cuts descending by startFrame', () => {
    const clip = makeClip({ mediaRef: 'm', startFrame: 0, durationFrames: 600 })
    const cuts = silencesToCuts(clip, [{ start: 1, end: 2 }, { start: 8, end: 9 }], 30, { paddingSec: 0, minSilenceSec: 0 })
    expect(cuts.map((c) => c.startFrame)).toEqual([240, 30])
  })
})

describe('pickDefaultSilenceTarget', () => {
  it('returns the single audible track first clip when unambiguous', () => {
    const tl = fxTimeline({
      tracks: [fxVideoTrack({ id: 'V', clips: [fxClip({ id: 'A', start: 0, duration: 30 })] })]
    })
    expect(pickDefaultSilenceTarget(tl)).toEqual({ clipId: 'A' })
  })

  it('lists candidates when several tracks are audible or none are', () => {
    const tl = fxTimeline({
      tracks: [
        fxVideoTrack({ id: 'V1', clips: [fxClip({ id: 'A', start: 0, duration: 30 })] }),
        fxAudioTrack({ id: 'A1', clips: [fxClip({ id: 'B', mediaType: 'audio', start: 0, duration: 30 })] })
      ]
    })
    const r = pickDefaultSilenceTarget(tl)
    expect('candidates' in r && r.candidates).toHaveLength(2)
    const empty = pickDefaultSilenceTarget(fxTimeline({ tracks: [] }))
    expect('candidates' in empty && empty.candidates).toHaveLength(0)
  })
})
