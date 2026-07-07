// SPDX-License-Identifier: GPL-3.0-or-later
// Bake planning: how timeline clips collapse into per-source / per-clip baked files.

import { describe, expect, it } from 'vitest'
import { makeAudioEnhance } from '../model/audioEnhance'
import { makeColorAdjustments } from '../model/color'
import type { MediaManifest, MediaManifestEntry } from '../model/manifest'
import { makeManifest } from '../model/manifest'
import { type Clip, makeClip, makeTimeline, makeTrack } from '../model/timeline'
import { clipJobIndex, planBakes } from './bakePlan'

function entry(id: string, over: Partial<MediaManifestEntry> = {}): MediaManifestEntry {
  return {
    id,
    name: id,
    type: 'video',
    source: { type: 'external', absolutePath: `C:/media/${id}.mp4` },
    duration: 10,
    hasAudio: true,
    ...over
  }
}
function manifestOf(...ids: string[]): MediaManifest {
  return makeManifest({ entries: ids.map((id) => entry(id)) })
}
function graded(over: Parameters<typeof makeColorAdjustments>[0]): Clip['color'] {
  return makeColorAdjustments(over)
}

describe('planBakes', () => {
  it('collapses one grade-per-source to a single baked file with all its clips', () => {
    const color = graded({ saturation: 1.3 })
    const a1 = { ...makeClip({ id: 'A1', mediaRef: 'cam', startFrame: 0, durationFrames: 30 }), color }
    const a2 = { ...makeClip({ id: 'A2', mediaRef: 'cam', startFrame: 30, durationFrames: 30, trimStartFrame: 30 }), color }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1, a2] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].mode).toBe('source')
    expect(jobs[0].needsBake).toBe(true)
    expect(jobs[0].clipIds).toEqual(['A1', 'A2'])
    // used window spans both clips: in = min trimStart (0), out = max (30 + 30)
    expect(jobs[0].inFrame).toBe(0)
    expect(jobs[0].outFrame).toBe(60)
  })

  it('splits one source into two jobs when its clips carry different grades', () => {
    const a1 = { ...makeClip({ id: 'A1', mediaRef: 'cam', startFrame: 0, durationFrames: 30 }), color: graded({ saturation: 1.3 }) }
    const a2 = { ...makeClip({ id: 'A2', mediaRef: 'cam', startFrame: 30, durationFrames: 30 }), color: graded({ contrast: 1.2 }) }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1, a2] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    expect(jobs).toHaveLength(2)
    expect(jobs.every((j) => j.needsBake)).toBe(true)
  })

  it('references the original (no bake) when a source needs no grade and no enhancement', () => {
    const c = makeClip({ id: 'A', mediaRef: 'cam', startFrame: 0, durationFrames: 30 })
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [c] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    expect(jobs).toHaveLength(1)
    expect(jobs[0].needsBake).toBe(false)
    expect(jobs[0].inFrame).toBe(0)
  })

  it('bakes audio enhancement even without a grade', () => {
    const c = { ...makeClip({ id: 'A', mediaRef: 'cam', startFrame: 0, durationFrames: 30 }), audioEnhance: makeAudioEnhance({ enabled: true }) }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [c] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    expect(jobs[0].needsBake).toBe(true)
    expect(jobs[0].audioEnhance).toBeTruthy()
  })

  it('bakes per-clip (speed baked in) when a clip is sped up', () => {
    const a1 = makeClip({ id: 'A1', mediaRef: 'cam', startFrame: 0, durationFrames: 30 })
    const a2 = makeClip({ id: 'A2', mediaRef: 'cam', startFrame: 30, durationFrames: 30, speed: 2 })
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1, a2] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    const clip = jobs.find((j) => j.mode === 'clip')
    expect(clip).toBeTruthy()
    expect(clip!.speed).toBe(2)
    expect(clip!.needsBake).toBe(true)
  })

  it('drops text and lottie clips (no bake job)', () => {
    const txt = { ...makeClip({ id: 'T', mediaRef: 'cam', startFrame: 0, durationFrames: 30 }), mediaType: 'text' as const }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [txt] })] })
    expect(planBakes(tl, manifestOf('cam'))).toHaveLength(0)
  })

  it('indexes clip ids back to their job', () => {
    const color = graded({ saturation: 1.3 })
    const a1 = { ...makeClip({ id: 'A1', mediaRef: 'cam', startFrame: 0, durationFrames: 30 }), color }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1] })] })
    const jobs = planBakes(tl, manifestOf('cam'))
    const idx = clipJobIndex(jobs)
    expect(idx.get('A1')).toBe(jobs[0])
  })
})
