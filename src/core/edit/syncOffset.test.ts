// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  type RmsCandidate,
  type TranscriptCandidate,
  findUnsyncedAnglePair,
  reconcileSyncOffset
} from './syncOffset'
import { type Clip, makeClip, makeTimeline, makeTrack } from '../model/timeline'

const rms = (offsetSeconds: number, extra: Partial<RmsCandidate> = {}): RmsCandidate => ({
  offsetSeconds,
  confidence: 0.883,
  margin: 0.449,
  reliable: true,
  ...extra
})
const transcript = (offsetSeconds: number, confidence: number, matched: number): TranscriptCandidate => ({
  offsetSeconds,
  confidence,
  matched
})

describe('reconcileSyncOffset', () => {
  it('returns null when neither estimator produced anything', () => {
    expect(reconcileSyncOffset(null, null)).toBeNull()
    // An unusable transcript (below the acceptance gates) counts as nothing.
    expect(reconcileSyncOffset(null, transcript(-4.6, 0.15, 3))).toBeNull()
  })

  it('uses RMS alone when there is no usable transcript', () => {
    const r = reconcileSyncOffset(rms(-4.67), null)!
    expect(r).toMatchObject({ offsetSeconds: -4.67, method: 'audio', reliable: true, reason: 'rms-only' })
    const weak = reconcileSyncOffset(rms(-4.67, { confidence: 0.3, margin: 0.05, reliable: false }), transcript(0, 0.15, 3))!
    expect(weak).toMatchObject({ method: 'audio', reliable: false, reason: 'rms-only' })
  })

  it('uses the transcript alone when RMS failed, with the stricter solo reliability bar', () => {
    const strong = reconcileSyncOffset(null, transcript(-4.6, 0.6, 20))!
    expect(strong).toMatchObject({ offsetSeconds: -4.6, method: 'transcript', reliable: true, reason: 'transcript-only' })
    const weak = reconcileSyncOffset(null, transcript(-4.6, 0.4, 8))!
    expect(weak).toMatchObject({ method: 'transcript', reliable: false, reason: 'transcript-only' })
  })

  it('REGRESSION: a reliable RMS peak refutes a confident-but-wrong transcript (the offset-0 bug)', () => {
    // Historical failure: a duplicated/poisoned transcript votes offset 0 with very high confidence.
    // The reliable −4.67 s correlation peak must win — this exact case shipped a 4.7 s lateral lag.
    const r = reconcileSyncOffset(rms(-4.67), transcript(0, 0.9, 50))!
    expect(r.offsetSeconds).toBe(-4.67)
    expect(r.method).toBe('audio')
    expect(r.reliable).toBe(true)
    expect(r.reason).toBe('transcript-refuted')
    expect(r.transcriptRefuted).toBe(true)
    expect(r.deltaSeconds).toBeCloseTo(4.67, 6)
  })

  it('lets the transcript refine an agreeing RMS peak (word timestamps are finer)', () => {
    const r = reconcileSyncOffset(rms(-4.67), transcript(-4.5, 0.6, 30))!
    expect(r).toMatchObject({ offsetSeconds: -4.5, method: 'transcript', reliable: true, reason: 'agreement' })
    expect(r.confidence).toBeCloseTo(0.883, 6) // max of both — the peak corroborates the words
  })

  it('applies the agreement tolerance as a boundary (0.4 s in, 0.41 s out)', () => {
    const agree = reconcileSyncOffset(rms(-4.6), transcript(-4.2, 0.6, 30))!
    expect(agree.reason).toBe('agreement')
    const refute = reconcileSyncOffset(rms(-4.6), transcript(-4.19, 0.6, 30))!
    expect(refute.reason).toBe('transcript-refuted')
    expect(refute.offsetSeconds).toBe(-4.6)
  })

  it('prefers a decent transcript over a weak disagreeing RMS, flagged unreliable', () => {
    const weakRms = rms(-9.9, { confidence: 0.3, margin: 0.04, reliable: false })
    const r = reconcileSyncOffset(weakRms, transcript(-4.6, 0.6, 20))!
    expect(r).toMatchObject({ offsetSeconds: -4.6, method: 'transcript', reliable: false, reason: 'disagreement-weak-rms' })
  })

  it('falls back to the weak RMS when both are weak and disagree', () => {
    const weakRms = rms(-9.9, { confidence: 0.3, margin: 0.04, reliable: false })
    const r = reconcileSyncOffset(weakRms, transcript(-4.6, 0.25, 10))!
    expect(r).toMatchObject({ offsetSeconds: -9.9, method: 'audio', reliable: false, reason: 'both-weak' })
  })

  it('passes positive offsets through unchanged (lateral started later ⇒ frontal gets trimmed)', () => {
    const r = reconcileSyncOffset(rms(4.67), null)!
    expect(r.offsetSeconds).toBe(4.67)
  })
})

// --- findUnsyncedAnglePair -------------------------------------------------------------------

function vClip(id: string, extra: Partial<Clip> = {}): Clip {
  return { ...makeClip({ mediaRef: `m_${id}`, startFrame: 0, durationFrames: 300, mediaType: 'video' }), id, ...extra }
}
function aClip(id: string): Clip {
  return { ...makeClip({ mediaRef: `m_${id}`, startFrame: 0, durationFrames: 300, mediaType: 'audio' }), id }
}

describe('findUnsyncedAnglePair', () => {
  it('finds the pair and calls the UPPER track clip the frontal', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('front')] }),
        makeTrack({ type: 'video', clips: [vClip('lat')] })
      ]
    })
    expect(findUnsyncedAnglePair(tl)).toEqual({ kind: 'pair', frontalClipId: 'front', lateralClipId: 'lat' })
  })

  it('reports synced when both clips share a linkGroupId (applySyncAngles already ran)', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('front', { linkGroupId: 'g1' })] }),
        makeTrack({ type: 'video', clips: [vClip('lat', { linkGroupId: 'g1' })] })
      ]
    })
    expect(findUnsyncedAnglePair(tl)).toEqual({ kind: 'synced' })
  })

  it('reports none with 0 or 1 video clips', () => {
    expect(findUnsyncedAnglePair(makeTimeline({ tracks: [] }))).toEqual({ kind: 'none' })
    const one = makeTimeline({ tracks: [makeTrack({ type: 'video', clips: [vClip('solo')] })] })
    expect(findUnsyncedAnglePair(one)).toEqual({ kind: 'none' })
  })

  it('is ambiguous with more than 2 video clips', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('a'), vClip('b', { startFrame: 300 })] }),
        makeTrack({ type: 'video', clips: [vClip('c')] })
      ]
    })
    expect(findUnsyncedAnglePair(tl).kind).toBe('ambiguous')
  })

  it('is ambiguous when both clips sit on the same track', () => {
    const tl = makeTimeline({
      tracks: [makeTrack({ type: 'video', clips: [vClip('a'), vClip('b', { startFrame: 300 })] })]
    })
    expect(findUnsyncedAnglePair(tl).kind).toBe('ambiguous')
  })

  it('is ambiguous when the two clips do not overlap in timeline time', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('a')] }),
        makeTrack({ type: 'video', clips: [vClip('b', { startFrame: 400 })] })
      ]
    })
    expect(findUnsyncedAnglePair(tl).kind).toBe('ambiguous')
  })

  it('is ambiguous on non-shared link groups (non-standard grouping)', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('a', { linkGroupId: 'g1' })] }),
        makeTrack({ type: 'video', clips: [vClip('b', { linkGroupId: 'g2' })] })
      ]
    })
    expect(findUnsyncedAnglePair(tl).kind).toBe('ambiguous')
  })

  it('ignores audio clips and audio tracks entirely', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('front')] }),
        makeTrack({ type: 'video', clips: [vClip('lat')] }),
        makeTrack({ type: 'audio', clips: [aClip('aud')] })
      ]
    })
    expect(findUnsyncedAnglePair(tl)).toEqual({ kind: 'pair', frontalClipId: 'front', lateralClipId: 'lat' })
  })

  it('accepts a partial overlap as a pair', () => {
    const tl = makeTimeline({
      tracks: [
        makeTrack({ type: 'video', clips: [vClip('a')] }),
        makeTrack({ type: 'video', clips: [vClip('b', { startFrame: 200 })] }) // overlaps 200..300
      ]
    })
    expect(findUnsyncedAnglePair(tl)).toEqual({ kind: 'pair', frontalClipId: 'a', lateralClipId: 'b' })
  })
})
