// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { buildTakeTimeline } from './takePlan'
import { type Clip, type Timeline, clipEndFrame, makeClip, makeTimeline, makeTrack, totalFrames } from '../model/timeline'
import { IDENTITY_COLOR } from '../model/color'
import { makeAudioEnhance } from '../model/audioEnhance'
import type { PlannedCut, PlannedTake } from '../ai/takesPlan'

const FPS = 30

function videoClip(mediaRef: string, extra: Partial<Clip> = {}): Clip {
  return { ...makeClip({ mediaRef, startFrame: 0, durationFrames: 300, mediaType: 'video' }), ...extra } // 10s @30
}
function audioClip(mediaRef: string): Clip {
  return makeClip({ mediaRef, startFrame: 0, durationFrames: 300, mediaType: 'audio' })
}
/** frontal video + lateral video + audio, all at frame 0 for 300 frames (synced multicam). */
function multicamBase(front: Clip, lat: Clip, aud: Clip): Timeline {
  return makeTimeline({
    fps: FPS,
    width: 1920,
    height: 1080,
    tracks: [
      makeTrack({ type: 'video', role: 'frontal', clips: [front] }),
      makeTrack({ type: 'video', role: 'lateral', clips: [lat] }),
      makeTrack({ type: 'audio', clips: [aud] })
    ]
  })
}
const take = (startMs: number, endMs: number): PlannedTake => ({ index: 1, startMs, endMs, title: 'g', summary: '' })
const cut = (startMs: number, endMs: number): PlannedCut => ({
  startMs,
  endMs,
  kind: 'muletilla',
  reason: '',
  text: '',
  takeIndex: 1,
  source: 'llm'
})

function expectAllTracksContiguous(tl: Timeline, frames: number): void {
  for (const t of tl.tracks) {
    const sorted = [...t.clips].sort((a, b) => a.startFrame - b.startFrame)
    expect(sorted.length).toBeGreaterThan(0)
    expect(sorted[0].startFrame).toBe(0)
    expect(clipEndFrame(sorted[sorted.length - 1])).toBe(frames)
  }
  expect(totalFrames(tl)).toBe(frames)
}

describe('buildTakeTimeline (multicam)', () => {
  it('trims ALL tracks to the take range, keeping both angles + audio', () => {
    const front = videoClip('m_front', { color: IDENTITY_COLOR })
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    // take 2s–8s → frames 60..240 = 180 frames
    const tl = buildTakeTimeline(base, front, take(2000, 8000), [])!
    expect(tl.tracks).toHaveLength(3)
    expectAllTracksContiguous(tl, 180)
    expect(tl.tracks.map((t) => t.clips[0].mediaRef)).toEqual(['m_front', 'm_lat', 'm_aud'])
  })

  it('preserves the per-clip color grade through the trim', () => {
    const front = videoClip('m_front', { color: IDENTITY_COLOR })
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    const tl = buildTakeTimeline(base, front, take(2000, 8000), [])!
    expect(tl.tracks[0].clips[0].color).toEqual(IDENTITY_COLOR)
  })

  it('inherits per-clip audioEnhance + the enhanced-audio mediaRef through the trim', () => {
    // Mirrors the real flow: the audio track holds the ENHANCED asset (mediaRef swapped by
    // replaceClipMedia) with per-clip audioEnhance DSP. Both must survive into the take timeline.
    const enhance = makeAudioEnhance({ presenceDb: 4 })
    const front = videoClip('m_front', { color: IDENTITY_COLOR })
    const aud: Clip = { ...audioClip('m_aud_enhanced'), audioEnhance: enhance }
    const base = multicamBase(front, videoClip('m_lat'), aud)
    const tl = buildTakeTimeline(base, front, take(2000, 8000), [])!
    const audioClipOut = tl.tracks[2].clips[0]
    expect(audioClipOut.mediaRef).toBe('m_aud_enhanced')
    expect(audioClipOut.audioEnhance).toEqual(enhance)
    expect(tl.tracks[0].clips[0].color).toEqual(IDENTITY_COLOR)
  })

  it('removes an internal cut inside the take across all tracks', () => {
    const front = videoClip('m_front')
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    // take 2s–8s (180f) minus cut 4s–5s (30f) → 150 frames
    const tl = buildTakeTimeline(base, front, take(2000, 8000), [cut(4000, 5000)])!
    expect(tl.tracks).toHaveLength(3)
    expectAllTracksContiguous(tl, 150)
  })

  it('keeps the whole timeline when the take spans it with no cuts', () => {
    const front = videoClip('m_front')
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    const tl = buildTakeTimeline(base, front, take(0, 10000), [])!
    expect(tl.tracks).toHaveLength(3)
    expectAllTracksContiguous(tl, 300)
  })

  it('still works on a single-track timeline', () => {
    const front = videoClip('m_front')
    const base = makeTimeline({ fps: FPS, width: 1920, height: 1080, tracks: [makeTrack({ type: 'video', clips: [front] })] })
    const tl = buildTakeTimeline(base, front, take(2000, 8000), [])!
    expect(tl.tracks).toHaveLength(1)
    expectAllTracksContiguous(tl, 180)
  })

  it('maps through post-sync trims: refClip = audio with trimStartFrame = sync offset', () => {
    // Real post-`applySyncAngles` shape: sync offset lives in trimStartFrame (5s = 150f @30),
    // every clip at startFrame 0. Take times are in the TRANSCRIBED FILE's time domain.
    const offset = 150
    const front = videoClip('m_front', { trimStartFrame: offset, color: IDENTITY_COLOR })
    const lat = videoClip('m_lat') // the other angle needed no trim
    const aud = { ...audioClip('m_aud'), trimStartFrame: offset }
    const base = multicamBase(front, lat, aud)
    // Take 7s–12s in audio-file time → source frames 210..360 → timeline frames 60..210 (150 frames).
    const tl = buildTakeTimeline(base, aud, take(7000, 12000), [])!
    expect(tl).not.toBeNull()
    expect(tl.tracks).toHaveLength(3)
    expectAllTracksContiguous(tl, 150)
    expect(tl.tracks[0].clips[0].color).toEqual(IDENTITY_COLOR)
    // The kept span starts 60 frames into the visible window: frontal trim = offset + 60.
    expect(tl.tracks[0].clips[0].trimStartFrame).toBe(offset + 60)
  })

  it('returns null for NaN take times instead of wiping the timeline', () => {
    // Regression: a poisoned transcript (NaN ms) used to collapse takeStart==takeEnd and the
    // head+tail removals then ripple-deleted EVERYTHING, opening empty tabs.
    const front = videoClip('m_front')
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    expect(buildTakeTimeline(base, front, take(NaN, NaN), [])).toBeNull()
  })

  it('returns null when the take falls entirely outside the ref clip window', () => {
    // Window shows source 5s–15s; a take wholly before it collapses to the clip edge → degenerate.
    const front = videoClip('m_front', { trimStartFrame: 150 })
    const base = multicamBase(front, videoClip('m_lat'), audioClip('m_aud'))
    expect(buildTakeTimeline(base, front, take(1000, 3000), [])).toBeNull()
  })
})
