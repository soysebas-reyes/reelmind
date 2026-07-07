// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { buildTakeTimeline, resyncTrackHeads } from './takePlan'
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

  it('keeps the two video angles frame-aligned + in sync (frontal trim 112 / lateral 0 / audio ref 112)', () => {
    // Exact shape of the reported project: frontal (C0429) trimStartFrame 112, lateral (C0480) 0, audio
    // extracted from the frontal also 112. buildTakeTimeline must keep BOTH video clips at timeline frame 0
    // (no per-track gap/lag) AND preserve their sync offset so neither angle drifts.
    const offset = 112
    const front = videoClip('c0429', { trimStartFrame: offset })
    const lat = videoClip('c0480', { trimStartFrame: 0 })
    const aud = { ...audioClip('c0429_audio'), trimStartFrame: offset }
    const base = multicamBase(front, lat, aud)
    const tl = buildTakeTimeline(base, aud, take(6000, 12000), [])! // 6s–12s in audio-file time
    expect(tl).not.toBeNull()
    expectAllTracksContiguous(tl, 180)
    const [frontOut, latOut, audOut] = tl.tracks.map((t) => t.clips[0])
    // Both video angles start at timeline frame 0 — the "V1 starts 2s after V2" gap must NOT happen.
    expect(frontOut.startFrame).toBe(0)
    expect(latOut.startFrame).toBe(0)
    // Sync preserved: the frontal shows a source frame exactly `offset` ahead of the lateral (same moment).
    expect(frontOut.trimStartFrame - latOut.trimStartFrame).toBe(offset)
    // Audio stays aligned with the frontal it was extracted from.
    expect(audOut.trimStartFrame).toBe(frontOut.trimStartFrame)
  })

  it('resyncTrackHeads pulls a lagging angle back to align (the Guión-1 desync case)', () => {
    // Reproduces the reported broken tab: the frontal ended up at startFrame 290 while the lateral/audio
    // were at 0 → the frontal plays ~12s out of sync. Resync must pull the lagging track to match the
    // others (frame 0 here) while keeping the trim offset intact (= the real sync between angles).
    const front = { ...videoClip('c0429', { trimStartFrame: 786 }), startFrame: 290 }
    const lat = videoClip('c0480', { trimStartFrame: 674 })
    const aud = { ...audioClip('c0429_audio'), trimStartFrame: 786 }
    const tl = multicamBase(front, lat, aud)
    resyncTrackHeads(tl)
    expect(tl.tracks[0].clips[0].startFrame).toBe(0) // frontal pulled back from 290 to match lateral/audio
    expect(tl.tracks[1].clips[0].startFrame).toBe(0)
    expect(tl.tracks[2].clips[0].startFrame).toBe(0)
    expect(tl.tracks[0].clips[0].trimStartFrame - tl.tracks[1].clips[0].trimStartFrame).toBe(112) // sync kept
  })

  it('resyncTrackHeads leaves an intentional intro gap shared by ALL tracks untouched', () => {
    // Every track starts at frame 30 (a 30-frame intro gap) → not a per-track divergence, so nothing moves.
    const front = { ...videoClip('c0429'), startFrame: 30 }
    const lat = { ...videoClip('c0480'), startFrame: 30 }
    const aud = { ...audioClip('c0429_audio'), startFrame: 30 }
    const tl = multicamBase(front, lat, aud)
    resyncTrackHeads(tl)
    expect(tl.tracks.map((t) => t.clips[0].startFrame)).toEqual([30, 30, 30])
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
