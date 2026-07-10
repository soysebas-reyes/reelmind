// SPDX-License-Identifier: GPL-3.0-or-later
// CapCut draft builder: deterministic materials/tracks/segments + microsecond time math + path form.

import { describe, expect, it } from 'vitest'
import { type Clip, makeClip, makeTimeline, makeTrack } from '../model/timeline'
import { type InterchangeSource } from './fcp7xml'
import { buildCapCutDraft, framesToUs, toCapCutPath } from './capcutDraft'

function src(over: Partial<InterchangeSource> = {}): InterchangeSource {
  return {
    fileId: 'file-1',
    mediaRef: 'a',
    bakeKey: 'k',
    name: 'a',
    fileUrl: 'file:///C:/media/a.mp4',
    filePath: 'C:\\media\\a.mp4',
    durationFrames: 300,
    width: 1920,
    height: 1080,
    hasAudio: false,
    mediaType: 'video',
    mode: 'source',
    bakedStartFrame: 0,
    ...over
  }
}

/** clipFile that returns a per-mediaRef source, or null for a given "offline" ref. */
function byRef(map: Record<string, InterchangeSource>) {
  return (clip: Clip): InterchangeSource | null => map[clip.mediaRef] ?? null
}

/** Deterministic id factory so the emitted draft is stable across runs. */
function counterIds(): () => string {
  let n = 0
  return () => `id-${++n}`
}

const NOW = 1_700_000_000_000 // fixed ms

function build(over: Partial<Parameters<typeof buildCapCutDraft>[0]>) {
  return buildCapCutDraft({
    timeline: makeTimeline(),
    draftName: 'Draft',
    draftFolderPath: 'C:\\drafts\\Draft-1',
    draftRootPath: 'C:\\drafts',
    sources: [],
    clipFile: () => null,
    newId: counterIds(),
    nowMs: NOW,
    ...over
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const materials = (r: { content: Record<string, unknown> }): any => (r.content as any).materials
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tracks = (r: { content: Record<string, unknown> }): any[] => (r.content as any).tracks

describe('framesToUs', () => {
  it('converts frames to integer microseconds at a given fps', () => {
    expect(framesToUs(60, 30)).toBe(2_000_000)
    expect(framesToUs(0, 30)).toBe(0)
    expect(framesToUs(1, 30)).toBe(33_333)
  })
})

describe('toCapCutPath', () => {
  it('forward-slashes Windows paths', () => {
    expect(toCapCutPath('C:\\media\\a.mp4')).toBe('C:/media/a.mp4')
    expect(toCapCutPath('/Users/seb/a.mp4')).toBe('/Users/seb/a.mp4')
  })
})

describe('buildCapCutDraft', () => {
  it('emits a valid, empty draft for an empty timeline', () => {
    const r = build({})
    expect(r.segmentCount).toBe(0)
    expect(tracks(r)).toEqual([])
    expect(materials(r).videos).toEqual([])
    // Load-bearing shape: CapCut indexes materials by key.
    expect(materials(r).speeds).toEqual([])
    expect((r.content as Record<string, unknown>).canvas_config).toEqual({ width: 1920, height: 1080, ratio: 'original' })
    expect((r.meta as Record<string, unknown>).draft_name).toBe('Draft')
    expect((r.meta as Record<string, unknown>).draft_fold_path).toBe('C:/drafts/Draft-1')
    expect((r.meta as Record<string, unknown>).draft_root_path).toBe('C:/drafts')
  })

  it('places a single full-frame video clip with exact microsecond timeranges + material path', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })
    const r = build({ timeline: tl, sources: [src()], clipFile: byRef({ a: src() }) })

    expect(r.segmentCount).toBe(1)
    const vids = materials(r).videos
    expect(vids).toHaveLength(1)
    expect(vids[0].path).toBe('C:/media/a.mp4')
    expect(vids[0].type).toBe('video')
    expect(vids[0].duration).toBe(framesToUs(300, 30))

    const seg = tracks(r)[0].segments[0]
    expect(seg.material_id).toBe(vids[0].id)
    expect(seg.target_timerange).toEqual({ start: 0, duration: 2_000_000 })
    expect(seg.source_timerange).toEqual({ start: 0, duration: 2_000_000 })
    expect(seg.clip.alpha).toBe(1)
    expect(seg.volume).toBe(1)
    // speed + canvas + sound_channel_mapping helper materials, referenced by id.
    expect(seg.extra_material_refs).toHaveLength(3)
    expect(materials(r).speeds).toHaveLength(1)
    expect(materials(r).canvases).toHaveLength(1)
    expect(materials(r).sound_channel_mappings).toHaveLength(1)
  })

  it('computes source_timerange from the baked window (trimmed) vs the whole original (full)', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60, trimStartFrame: 30 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })

    const trimmed = src({ bakedStartFrame: 30 })
    const rt = build({ timeline: tl, sources: [trimmed], clipFile: byRef({ a: trimmed }) })
    expect(tracks(rt)[0].segments[0].source_timerange).toEqual({ start: 0, duration: 2_000_000 })

    const full = src({ bakedStartFrame: 0 })
    const rf = build({ timeline: tl, sources: [full], clipFile: byRef({ a: full }) })
    expect(tracks(rf)[0].segments[0].source_timerange).toEqual({ start: 1_000_000, duration: 2_000_000 })
  })

  it('skips the hidden (opacity 0) angle; a video segment carries its own audio (no separate audio segment)', () => {
    const front = { ...makeClip({ id: 'F', mediaRef: 'front', startFrame: 0, durationFrames: 60 }), opacity: 1 }
    const hidden = { ...makeClip({ id: 'H', mediaRef: 'lat', startFrame: 0, durationFrames: 60 }), opacity: 0 }
    const tl = makeTimeline({
      fps: 30,
      tracks: [makeTrack({ id: 'v1', type: 'video', clips: [front] }), makeTrack({ id: 'v2', type: 'video', clips: [hidden] })]
    })
    const withAudio = src({ fileId: 'file-front', mediaRef: 'front', hasAudio: true })
    const r = build({ timeline: tl, sources: [withAudio], clipFile: byRef({ front: withAudio }) })

    expect(r.segmentCount).toBe(1) // only the visible angle; CapCut plays its embedded audio
    expect(materials(r).videos).toHaveLength(1)
    expect(materials(r).videos[0].has_audio).toBe(true)
    // The hidden angle contributed no material (its src was never resolved).
    expect(materials(r).videos.map((m: { material_name: string }) => m.material_name)).toEqual(['a'])
  })

  it('assigns render_index so the foreground track (index 0) stacks on top', () => {
    const fg = makeClip({ id: 'FG', mediaRef: 'fg', startFrame: 0, durationFrames: 60 })
    const bg = makeClip({ id: 'BG', mediaRef: 'bg', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({
      fps: 30,
      // track index 0 = foreground, index 1 = background
      tracks: [makeTrack({ id: 't0', type: 'video', clips: [fg] }), makeTrack({ id: 't1', type: 'video', clips: [bg] })]
    })
    const sFg = src({ fileId: 'file-fg', mediaRef: 'fg' })
    const sBg = src({ fileId: 'file-bg', mediaRef: 'bg' })
    const r = build({ timeline: tl, sources: [sFg, sBg], clipFile: byRef({ fg: sFg, bg: sBg }) })

    // Emitted bottom-to-top: [bg (render_index 0), fg (render_index 1)] → fg on top.
    const emitted = tracks(r)
    expect(emitted).toHaveLength(2)
    expect(emitted[0].segments[0].render_index).toBe(0)
    expect(emitted[emitted.length - 1].segments[0].render_index).toBe(1)
    // The foreground clip's source ('fg') is the one on the top (last) track.
    const topMatId = emitted[emitted.length - 1].segments[0].material_id
    const topMat = materials(r).videos.find((m: { id: string }) => m.id === topMatId)
    expect(topMat.path).toBe(toCapCutPath('C:\\media\\a.mp4'))
  })

  it('dedups: two clips of one source share a material but emit two segments', () => {
    const a1 = makeClip({ id: 'A1', mediaRef: 'a', startFrame: 0, durationFrames: 30 })
    const a2 = makeClip({ id: 'A2', mediaRef: 'a', startFrame: 30, durationFrames: 30 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1, a2] })] })
    const s = src()
    const r = build({ timeline: tl, sources: [s], clipFile: byRef({ a: s }) })
    expect(materials(r).videos).toHaveLength(1)
    expect(tracks(r)[0].segments).toHaveLength(2)
    expect(r.segmentCount).toBe(2)
  })

  it('routes an audio-track clip to an audio material + audio segment', () => {
    const a = makeClip({ id: 'AU', mediaRef: 'voz', mediaType: 'audio', startFrame: 0, durationFrames: 90 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'au', type: 'audio', clips: [a] })] })
    const s = src({ fileId: 'file-au', mediaRef: 'voz', mediaType: 'audio', hasAudio: true, name: 'voz' })
    const r = build({ timeline: tl, sources: [s], clipFile: byRef({ voz: s }) })
    expect(materials(r).audios).toHaveLength(1)
    expect(materials(r).videos).toHaveLength(0)
    expect(tracks(r)[0].type).toBe('audio')
    // Audio segments reference speed + sound_channel_mapping (no canvas).
    expect(tracks(r)[0].segments[0].extra_material_refs).toHaveLength(2)
  })

  it('drops text clips and reports a warning', () => {
    const txt = { ...makeClip({ id: 'T', mediaRef: 't', startFrame: 0, durationFrames: 30 }), mediaType: 'text' as const, textContent: 'Hola' }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [txt] })] })
    const r = build({ timeline: tl, sources: [], clipFile: () => src() })
    expect(r.segmentCount).toBe(0)
    expect(r.warnings.some((w) => w.includes('texto'))).toBe(true)
  })

  it('skips offline clips (clipFile → null) and warns', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'gone', startFrame: 0, durationFrames: 30 })
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })
    const r = build({ timeline: tl, sources: [], clipFile: () => null })
    expect(r.segmentCount).toBe(0)
    expect(r.warnings.some((w) => w.includes('media disponible'))).toBe(true)
  })

  it('lists every source in draft_meta_info draft_materials', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })
    const s = src()
    const r = build({ timeline: tl, sources: [s], clipFile: byRef({ a: s }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dm = (r.meta as any).draft_materials.find((m: { type: number }) => m.type === 0)
    expect(dm.value).toHaveLength(1)
    expect(dm.value[0].file_Path).toBe('C:/media/a.mp4')
    expect(dm.value[0].metetype).toBe('video')
  })
})
