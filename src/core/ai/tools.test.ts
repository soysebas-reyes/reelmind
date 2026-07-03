// SPDX-License-Identifier: GPL-3.0-or-later
// AI tool contract: schema validation, dispatch to the controller, agent tagging, query results.

import { describe, expect, it } from 'vitest'
import { EditorController } from '../controller/EditorController'
import { HOST_EXECUTED_TOOLS, editorTools, executeTool, extractToolImage, summarizeTimeline, toJsonSchemaTools } from './tools'

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

describe('batch_operations', () => {
  it('runs N core ops in order as ONE undo step and returns per-op results', () => {
    const c = new EditorController()
    const r = rec(
      executeTool(c, 'batch_operations', {
        operations: [
          { tool: 'add_track', input: { type: 'video' } },
          { tool: 'set_fps', input: { fps: 25 } },
          { tool: 'set_resolution', input: { width: 1280, height: 720 } }
        ]
      }).result
    )
    expect(r.appliedCount).toBe(3)
    expect(r.firstError).toBeUndefined()
    const results = r.results as Rec[]
    expect(results[0].trackId).toBeTruthy()
    expect(c.getTimeline().fps).toBe(25)
    expect(c.getTimeline().width).toBe(1280)
    c.undo() // one step reverts all three
    expect(c.getTimeline().tracks).toHaveLength(0)
    expect(c.getTimeline().fps).toBe(30)
    expect(c.canUndo()).toBe(false)
  })

  it('pre-validates every input: one invalid op means NOTHING runs', () => {
    const c = new EditorController()
    const r = executeTool(c, 'batch_operations', {
      operations: [
        { tool: 'add_track', input: { type: 'video' } },
        { tool: 'add_track', input: { type: 'hologram' } } // invalid enum
      ]
    })
    expect(rec(r.result).error).toMatch(/Operation 1/)
    expect(c.getTimeline().tracks).toHaveLength(0)
    expect(c.canUndo()).toBe(false)
  })

  it('rejects host tools, undo/redo, and nested batches up front', () => {
    const c = new EditorController()
    for (const tool of ['export', 'undo', 'batch_operations']) {
      const r = executeTool(c, 'batch_operations', { operations: [{ tool, input: {} }] })
      expect(rec(r.result).error).toBeTruthy()
    }
    expect(c.canUndo()).toBe(false)
  })

  it('stops at the first failing op (stopOnError default), keeping earlier ops applied', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    c.reset(c.getTimeline())
    const r = rec(
      executeTool(c, 'batch_operations', {
        operations: [
          { tool: 'add_clip', input: { trackId, mediaRef: 'a', startFrame: 0, durationFrames: 30 } },
          { tool: 'add_clip', input: { trackId: 'ghost', mediaRef: 'b', startFrame: 50, durationFrames: 30 } },
          { tool: 'add_clip', input: { trackId, mediaRef: 'c', startFrame: 100, durationFrames: 30 } }
        ]
      }).result
    )
    expect(r.firstError).toMatch(/op 1/)
    expect(r.appliedCount).toBe(2) // op 2 never ran
    expect(c.getTimeline().tracks[0].clips).toHaveLength(1) // op 0 stayed applied
    c.undo()
    expect(c.getTimeline().tracks[0].clips).toHaveLength(0)
  })

  it('enforces the 50-op cap', () => {
    const c = new EditorController()
    const operations = Array.from({ length: 51 }, () => ({ tool: 'seek', input: { frame: 0 } }))
    expect(executeTool(c, 'batch_operations', { operations }).ok).toBe(false)
  })
})

describe('list_assets (host-only declaration)', () => {
  it('advertises list_assets but the core executor refuses it', () => {
    const c = new EditorController()
    expect(HOST_EXECUTED_TOOLS.has('list_assets')).toBe(true)
    const r = executeTool(c, 'list_assets', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/host/i)
  })
})

describe('keyframe tools', () => {
  it('set_keyframe converts timeline→clip frames and get_keyframes reads both back', () => {
    const c = new EditorController()
    const trackId = rec(executeTool(c, 'add_track', { type: 'video' }).result).trackId as string
    const clipId = rec(
      executeTool(c, 'add_clip', { trackId, mediaRef: 'a', startFrame: 100, durationFrames: 60 }).result
    ).clipId as string
    const r = executeTool(c, 'set_keyframe', { clipId, property: 'opacity', atFrame: 130, value: 0.5 })
    expect(rec(r.result).clipFrame).toBe(30)
    const kf = rec(executeTool(c, 'get_keyframes', { clipId, property: 'opacity' }).result)
    const list = (kf.keyframes as Rec).opacity as Rec[]
    expect(list[0]).toMatchObject({ clipFrame: 30, timelineFrame: 130, value: 0.5, interpolation: 'smooth' })
  })

  it('rejects frames outside the clip and value-shape mismatches with precise errors', () => {
    const { c, clipId } = withClip() // clip [0, 60)
    const outside = rec(executeTool(c, 'set_keyframe', { clipId, property: 'opacity', atFrame: 90, value: 1 }).result)
    expect(outside.error).toMatch(/outside the clip/)
    const badShape = rec(
      executeTool(c, 'set_keyframe', { clipId, property: 'position', atFrame: 10, value: 0.5 }).result
    )
    expect(badShape.error).toMatch(/\{x, y\}/)
    const badVolume = rec(
      executeTool(c, 'set_keyframe', { clipId, property: 'volume', atFrame: 10, value: 100 }).result
    )
    expect(badVolume.error).toMatch(/dB/)
  })

  it('position/scale/crop values map to the controller shapes', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_keyframe', { clipId, property: 'position', atFrame: 0, value: { x: 0.1, y: 0.2 } })
    executeTool(c, 'set_keyframe', { clipId, property: 'scale', atFrame: 30, value: { width: 0.5, height: 0.5 } })
    executeTool(c, 'set_keyframe', { clipId, property: 'crop', atFrame: 30, value: { left: 0.25 } })
    const clip = c.getClip(clipId)!
    expect(clip.positionTrack!.keyframes[0].value).toEqual({ a: 0.1, b: 0.2 })
    expect(clip.scaleTrack!.keyframes[0].value).toEqual({ a: 0.5, b: 0.5 })
    expect(clip.cropTrack!.keyframes[0].value).toEqual({ left: 0.25, top: 0, right: 0, bottom: 0 })
  })

  it('remove_keyframe removes one frame or all, and is agent-tagged', () => {
    const { c, clipId } = withClip()
    executeTool(c, 'set_keyframe', { clipId, property: 'volume', atFrame: 0, value: 0 })
    executeTool(c, 'set_keyframe', { clipId, property: 'volume', atFrame: 30, value: -12 })
    executeTool(c, 'remove_keyframe', { clipId, property: 'volume', atFrame: 30 })
    expect(c.getClip(clipId)!.volumeTrack!.keyframes).toHaveLength(1)
    expect(c.snapshot().undoOrigin).toBe('agent')
    executeTool(c, 'remove_keyframe', { clipId, property: 'volume', all: true })
    expect(c.getClip(clipId)!.volumeTrack).toBeUndefined()
  })
})

describe('ripple_delete_range tool', () => {
  it('removes a mid-clip range and closes the gap', () => {
    const { c, clipId, trackId } = withClip() // [0, 60)
    void clipId
    const r = rec(executeTool(c, 'ripple_delete_range', { startFrame: 20, endFrame: 40, trackIds: [trackId] }).result)
    expect(r.ok).toBe(true)
    expect(r.removedFrames).toBe(20)
    const clips = c.getTimeline().tracks[0].clips
    expect(clips.map((cl) => [cl.startFrame, cl.startFrame + cl.durationFrames])).toEqual([
      [0, 20],
      [20, 40]
    ])
  })

  it('surfaces the refusal reason as a result (not a throw)', () => {
    const c = new EditorController()
    const r = executeTool(c, 'ripple_delete_range', { startFrame: 0, endFrame: 10 })
    expect(r.ok).toBe(true)
    expect(rec(r.result).ok).toBe(false)
  })
})

describe('add_text_clip', () => {
  it('creates a text track when none exists and applies defaults + overrides', () => {
    const c = new EditorController()
    const r = rec(
      executeTool(c, 'add_text_clip', {
        text: 'Hola mundo',
        startFrame: 30,
        durationFrames: 90,
        style: { fontSize: 72 }
      }).result
    )
    expect(r.clipId).toBeTruthy()
    const clip = c.getClip(r.clipId as string)!
    expect(clip.mediaType).toBe('text')
    expect(clip.textContent).toBe('Hola mundo')
    expect(clip.textStyle).toMatchObject({ fontName: 'Segoe UI', fontSize: 72, color: '#ffffff', alignment: 'center' })
    expect(clip.mediaRef.startsWith('text-')).toBe(true)
    const track = c.getTrackOfClip(clip.id)!
    expect(track.type).toBe('text')
    // One undo step total (track + clip + props).
    c.undo()
    expect(c.getTimeline().tracks).toHaveLength(0)
    expect(c.canUndo()).toBe(false)
  })

  it('reuses an existing text track, gives unique mediaRefs, and validates a passed trackId', () => {
    const c = new EditorController()
    const r1 = rec(executeTool(c, 'add_text_clip', { text: 'Uno', startFrame: 0, durationFrames: 30 }).result)
    const r2 = rec(executeTool(c, 'add_text_clip', { text: 'Dos', startFrame: 60, durationFrames: 30 }).result)
    expect(r2.trackId).toBe(r1.trackId)
    expect(c.getClip(r1.clipId as string)!.mediaRef).not.toBe(c.getClip(r2.clipId as string)!.mediaRef)
    const videoTrack = c.addTrack('video')
    const bad = rec(
      executeTool(c, 'add_text_clip', { text: 'Mal', startFrame: 0, durationFrames: 30, trackId: videoTrack }).result
    )
    expect(bad.error).toMatch(/not "text"/)
  })
})

describe('get_frame_preview declaration + extractToolImage', () => {
  it('is host-only and the core executor refuses it', () => {
    const c = new EditorController()
    expect(HOST_EXECUTED_TOOLS.has('get_frame_preview')).toBe(true)
    const r = executeTool(c, 'get_frame_preview', {})
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/host/i)
  })

  it('extractToolImage splits the sentinel and ignores ordinary results', () => {
    const split = extractToolImage({ frame: 30, image: { mimeType: 'image/png', base64: 'QUJD' } })
    expect(split?.image.mimeType).toBe('image/png')
    expect(split?.rest).toEqual({ frame: 30 })
    expect(extractToolImage({ ok: true })).toBeNull()
    expect(extractToolImage(null)).toBeNull()
    expect(extractToolImage({ image: 'not-an-object' })).toBeNull()
    expect(extractToolImage({ image: { mimeType: 'image/png' } })).toBeNull() // missing base64
  })
})
