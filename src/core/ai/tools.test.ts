// SPDX-License-Identifier: GPL-3.0-or-later
// AI tool contract: schema validation, dispatch to the controller, agent tagging, query results.

import { describe, expect, it } from 'vitest'
import { EditorController } from '../controller/EditorController'
import { editorTools, executeTool, summarizeTimeline, toJsonSchemaTools } from './tools'

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
