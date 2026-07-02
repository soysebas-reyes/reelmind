// SPDX-License-Identifier: GPL-3.0-or-later
// AI tool contract: schema validation, dispatch to the controller, agent tagging, query results.

import { describe, expect, it } from 'vitest'
import { EditorController } from '../controller/EditorController'
import { HOST_EXECUTED_TOOLS, editorTools, executeTool, summarizeTimeline, toJsonSchemaTools } from './tools'

interface Rec {
  [k: string]: unknown
}
const rec = (v: unknown): Rec => v as Rec

describe('executeTool — validation & dispatch', () => {
  it('rejects an unknown tool', () => {
    const c = new EditorController()
    const r = executeTool(c, 'frobnicate', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Unknown tool/)
  })

  it('rejects input that fails the schema', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    const r = executeTool(c, 'add_clip', { trackId, mediaRef: 'm', startFrame: 0 }) // missing durationFrames
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/durationFrames/)
  })

  it('rejects an invalid enum value', () => {
    const c = new EditorController()
    const r = executeTool(c, 'add_track', { type: 'hologram' })
    expect(r.ok).toBe(false)
  })

  it('adds a track and a clip, returning their ids', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    expect(trackId).toBeTruthy()
    const r = executeTool(c, 'add_clip', { trackId, mediaRef: 'asset1', startFrame: 0, durationFrames: 90 })
    expect(r.ok).toBe(true)
    const clipId = rec(r.result).clipId as string
    expect(c.getClip(clipId)?.durationFrames).toBe(90)
  })

  it('tags tool-driven edits as agent in the undo history', () => {
    const c = new EditorController()
    executeTool(c, 'add_track', { type: 'video' })
    expect(c.snapshot().undoOrigin).toBe('agent')
  })

  it('runs split / ripple_delete and returns their results', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    executeTool(c, 'add_clip', { trackId, mediaRef: 'm', startFrame: 0, durationFrames: 100, id: undefined })
    const clipId = c.getTimeline().tracks[0].clips[0].id
    const split = executeTool(c, 'split_clip', { clipId, atFrame: 40 })
    expect(rec(split.result).rightId).toBeTruthy()

    const rd = executeTool(c, 'ripple_delete', { clipIds: [clipId] })
    expect(rec(rd.result).ok).toBe(true)
  })

  it('get_timeline reflects the current project', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    executeTool(c, 'add_clip', { trackId, mediaRef: 'asset1', startFrame: 10, durationFrames: 50 })
    const summary = rec(executeTool(c, 'get_timeline', {}).result)
    expect(summary.totalFrames).toBe(60)
    const tracks = summary.tracks as { clips: { mediaRef: string; startFrame: number }[] }[]
    expect(tracks[0].clips[0]).toMatchObject({ mediaRef: 'asset1', startFrame: 10 })
  })

  it('undo / redo tools step the history', () => {
    const c = new EditorController()
    executeTool(c, 'add_track', { type: 'video' })
    expect(rec(executeTool(c, 'undo', {}).result).done).toBe(true)
    expect(c.getTimeline().tracks).toHaveLength(0)
    expect(rec(executeTool(c, 'redo', {}).result).done).toBe(true)
    expect(c.getTimeline().tracks).toHaveLength(1)
  })

  it('every tool has a unique name and a description', () => {
    const names = editorTools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of editorTools) expect(t.description.length).toBeGreaterThan(10)
  })

  it('advertises import_media but the core executor refuses it (host-only)', () => {
    const c = new EditorController()
    expect(editorTools.some((t) => t.name === 'import_media')).toBe(true)
    const r = executeTool(c, 'import_media', { sources: ['https://example.com/clip.mp4'] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/host/i)
  })

  it('advertises import_folder + export as host-only tools the core executor refuses', () => {
    const c = new EditorController()
    expect(HOST_EXECUTED_TOOLS.has('import_folder')).toBe(true)
    expect(HOST_EXECUTED_TOOLS.has('export')).toBe(true)
    const folder = executeTool(c, 'import_folder', { folderPath: 'D:/crudos' })
    expect(folder.ok).toBe(false)
    expect(folder.error).toMatch(/host/i)
    const exp = executeTool(c, 'export', { outputPath: 'D:/out/video.mp4' })
    expect(exp.ok).toBe(false)
    expect(exp.error).toMatch(/host/i)
    expect(HOST_EXECUTED_TOOLS.has('remove_silences')).toBe(true)
    const rs = executeTool(c, 'remove_silences', {})
    expect(rs.ok).toBe(false)
    expect(rs.error).toMatch(/host/i)
  })

  it('rejects export / import_folder when required fields are missing', () => {
    const c = new EditorController()
    expect(executeTool(c, 'export', {}).ok).toBe(false)
    expect(executeTool(c, 'import_folder', {}).ok).toBe(false)
  })

  it('exposes transport-ready JSON-Schema tools', () => {
    const tools = toJsonSchemaTools()
    expect(tools.length).toBe(editorTools.length)
    const addClip = tools.find((t) => t.name === 'add_clip')!
    expect(addClip.inputSchema.type).toBe('object')
    const props = addClip.inputSchema.properties as Record<string, unknown>
    expect(props.trackId).toBeDefined()
    expect(props.durationFrames).toBeDefined()
    expect(addClip.inputSchema.required).toEqual(expect.arrayContaining(['trackId', 'mediaRef', 'startFrame', 'durationFrames']))
    expect(() => JSON.stringify(tools)).not.toThrow()
  })
})

describe('summarizeTimeline', () => {
  it('produces a JSON-serializable snapshot', () => {
    const c = new EditorController()
    const trackId = c.addTrack('video')
    c.addClip({ trackId, mediaRef: 'm', startFrame: 0, durationFrames: 30 })
    const summary = summarizeTimeline(c)
    expect(() => JSON.stringify(summary)).not.toThrow()
  })
})

function withClip(): { c: EditorController; clipId: string; trackId: string } {
  const c = new EditorController()
  const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
  const clipId = rec(executeTool(c, 'add_clip', { trackId, mediaRef: 'a', startFrame: 0, durationFrames: 60 }).result)
    .clipId as string
  return { c, clipId, trackId }
}

describe('set_clip_properties (widened) + set_clips_properties', () => {
  it('merges a partial transform without resetting other transform fields', () => {
    const { c, clipId } = withClip()
    expect(executeTool(c, 'set_clip_properties', { clipId, transform: { centerX: 0.25 } }).ok).toBe(true)
    expect(executeTool(c, 'set_clip_properties', { clipId, transform: { rotation: 45 } }).ok).toBe(true)
    const t = c.getClip(clipId)!.transform
    expect(t.centerX).toBe(0.25) // preserved across the rotation-only edit
    expect(t.rotation).toBe(45)
    expect(t.width).toBe(1) // untouched default
  })

  it('merges crop and textStyle patches and sets textContent', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, crop: { left: 0.1 }, textContent: 'Hola', textStyle: { fontSize: 64 } })
    executeTool(c, 'set_clip_properties', { clipId, crop: { right: 0.2 }, textStyle: { color: '#ff0000' } })
    const clip = c.getClip(clipId)!
    expect(clip.crop.left).toBe(0.1)
    expect(clip.crop.right).toBe(0.2)
    expect(clip.textContent).toBe('Hola')
    expect(clip.textStyle?.fontSize).toBe(64) // preserved
    expect(clip.textStyle?.color).toBe('#ff0000')
    expect(clip.textStyle?.fontName).toBeTruthy() // default filled in
  })

  it('routes speed through setClipSpeed (duration recomputes)', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, speed: 2 })
    const clip = c.getClip(clipId)!
    expect(clip.speed).toBe(2)
    expect(clip.durationFrames).toBe(30) // 60 source frames at 2x
  })

  it('merges an audioEnhance patch (other knobs keep defaults)', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, audioEnhance: { denoiseAmount: 20 } })
    const ae = c.getClip(clipId)!.audioEnhance!
    expect(ae.denoiseAmount).toBe(20)
    expect(ae.compRatio).toBe(3) // default preserved
  })

  it('sets fade interpolation and errors on an unknown clip', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, fadeInFrames: 10, fadeInInterpolation: 'smooth' })
    expect(c.getClip(clipId)!.fadeInInterpolation).toBe('smooth')
    const r = executeTool(c, 'set_clip_properties', { clipId: 'nope', volume: 0 })
    expect(rec(r.result).error).toMatch(/Clip not found/)
  })

  it('rejects out-of-range crop values', () => {
    const { c, clipId } = withClip()
    expect(executeTool(c, 'set_clip_properties', { clipId, crop: { left: 1.5 } }).ok).toBe(false)
  })

  it('set_clips_properties edits several clips as ONE undo step', () => {
    const { c, trackId } = withClip()
    const id2 = rec(executeTool(c, 'add_clip', { trackId, mediaRef: 'b', startFrame: 100, durationFrames: 60 }).result)
      .clipId as string
    const id3 = rec(executeTool(c, 'add_clip', { trackId, mediaRef: 'c', startFrame: 200, durationFrames: 60 }).result)
      .clipId as string
    const ids = [c.getTimeline().tracks[0].clips[0].id, id2, id3]
    const r = executeTool(c, 'set_clips_properties', { clipIds: ids, volume: 0 })
    expect(rec(r.result).applied).toBe(3)
    for (const id of ids) expect(c.getClip(id)!.volume).toBe(0)
    c.undo() // one step reverts all three
    for (const id of ids) expect(c.getClip(id)!.volume).toBe(1)
  })

  it('set_clips_properties reports every missing clip without mutating', () => {
    const { c, clipId } = withClip()
    const r = executeTool(c, 'set_clips_properties', { clipIds: [clipId, 'ghost'], opacity: 0.5 })
    expect(rec(r.result).error).toMatch(/ghost/)
    expect(c.getClip(clipId)!.opacity).toBe(1)
  })
})

describe('inspect_clip', () => {
  it('returns full clip detail with track context and seconds', () => {
    const { c, clipId, trackId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, transform: { rotation: 30 }, textContent: 'Título' })
    const r = rec(executeTool(c, 'inspect_clip', { clipId }).result)
    expect(rec(r.clip).id).toBe(clipId)
    expect((rec(r.clip).transform as { rotation: number }).rotation).toBe(30)
    expect(rec(r.track).id).toBe(trackId)
    expect(r.endFrame).toBe(60)
    expect(r.durationSeconds).toBe(2) // 60 frames @ 30fps default
    expect(() => JSON.stringify(r)).not.toThrow()
  })

  it('creates no undo entry and errors on unknown clip', () => {
    const { c, clipId } = withClip()
    const before = c.snapshot().undoLabel
    executeTool(c, 'inspect_clip', { clipId })
    expect(c.snapshot().undoLabel).toBe(before)
    const r = rec(executeTool(c, 'inspect_clip', { clipId: 'nope' }).result)
    expect(r.error).toMatch(/Clip not found/)
  })
})

describe('color presets', () => {
  it('list_color_presets returns looks and presets with ids', () => {
    const c = new EditorController()
    const r = rec(executeTool(c, 'list_color_presets', {}).result)
    const looks = r.looks as { id: string }[]
    const presets = r.presets as { id: string }[]
    expect(looks.some((l) => l.id === 'warm')).toBe(true)
    expect(presets.some((p) => p.id === 'guillermo-frontal-v1')).toBe(true)
  })

  it('a look MERGES onto the current grade; a preset REPLACES it', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_color', { clipId, saturation: 0.5 })
    executeTool(c, 'apply_color_preset', { clipIds: [clipId], presetId: 'warm' })
    let color = c.getClip(clipId)!.color!
    expect(color.saturation).toBe(0.5) // look kept it
    expect(color.temperature).toBe(25)

    const r = executeTool(c, 'apply_color_preset', { clipIds: [clipId], presetId: 'guillermo-frontal-v1' })
    expect(rec(r.result).mode).toBe('preset')
    color = c.getClip(clipId)!.color!
    expect(color.saturation).toBe(0.88) // full replace
    expect(color.lutRef).toMatch(/Frontal/)
  })

  it('multi-clip apply is one undo step; unknown ids error listing valid ones', () => {
    const { c, trackId } = withClip()
    const id2 = rec(executeTool(c, 'add_clip', { trackId, mediaRef: 'b', startFrame: 100, durationFrames: 30 }).result)
      .clipId as string
    const id1 = c.getTimeline().tracks[0].clips[0].id
    executeTool(c, 'apply_color_preset', { clipIds: [id1, id2], presetId: 'bw' })
    expect(c.getClip(id1)!.color!.saturation).toBe(0)
    expect(c.getClip(id2)!.color!.saturation).toBe(0)
    c.undo()
    expect(c.getClip(id1)!.color?.saturation).not.toBe(0)

    const bad = rec(executeTool(c, 'apply_color_preset', { clipIds: [id1], presetId: 'sunset' }).result)
    expect(bad.error).toMatch(/Valid ids/)
  })
})

describe('summarizeTimeline enrichment', () => {
  it('truncates long textContent and reports hasKeyframes=false by default', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_properties', { clipId, textContent: 'x'.repeat(60) })
    const summary = rec(summarizeTimeline(c))
    const clips = (summary.tracks as { clips: Rec[] }[])[0].clips
    expect((clips[0].textContent as string).length).toBe(41) // 40 + ellipsis
    expect(clips[0].hasKeyframes).toBe(false)
  })
})

describe('set_clip_color (P9.5)', () => {

  it('merges color fields onto a clip across calls', () => {
    const { c, clipId } = withClip()
    expect(executeTool(c, 'set_clip_color', { clipId, saturation: 0.88 }).ok).toBe(true)
    expect(executeTool(c, 'set_clip_color', { clipId, contrast: 1.2, shadows: 8.6 }).ok).toBe(true)
    const color = c.getClip(clipId)!.color!
    expect(color.saturation).toBe(0.88) // preserved (merge, not reset)
    expect(color.contrast).toBe(1.2)
    expect(color.shadows).toBe(8.6)
  })

  it('rejects out-of-range values', () => {
    const { c, clipId } = withClip()
    expect(executeTool(c, 'set_clip_color', { clipId, saturation: 5 }).ok).toBe(false) // max 2
    expect(executeTool(c, 'set_clip_color', { clipId, temperature: -500 }).ok).toBe(false) // min -100
  })

  it('is agent-tagged and surfaces color in summarizeTimeline', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_clip_color', { clipId, saturation: 0.88 })
    expect(c.snapshot().undoOrigin).toBe('agent')
    const summary = rec(summarizeTimeline(c))
    const tracks = summary.tracks as { clips: { color?: { saturation: number } }[] }[]
    expect(tracks[0].clips[0].color?.saturation).toBe(0.88)
  })
})
