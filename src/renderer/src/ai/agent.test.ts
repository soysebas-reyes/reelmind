// SPDX-License-Identifier: GPL-3.0-or-later
// Agent loop: tool-use dispatch against the live controller, error handling, and step termination.
// The model is faked, so this runs without the network.

import { describe, expect, it } from 'vitest'
import { EditorController } from '@core'
import { type AgentEvent, type ModelCaller, type ModelResponse, anthropicTools, runAgent } from './agent'

const toolUse = (id: string, name: string, input: unknown): ModelResponse => ({
  ok: true,
  stopReason: 'tool_use',
  content: [{ type: 'tool_use', id, name, input }]
})
const say = (text: string): ModelResponse => ({ ok: true, stopReason: 'end_turn', content: [{ type: 'text', text }] })

describe('runAgent', () => {
  it('executes a tool call against the controller, then finishes on text', async () => {
    const c = new EditorController()
    let n = 0
    const callModel: ModelCaller = async () => (++n === 1 ? toolUse('t1', 'add_track', { type: 'video' }) : say('Added a video track.'))

    const events: AgentEvent[] = []
    const result = await runAgent(c, [{ role: 'user', content: 'add a video track' }], callModel, (e) => events.push(e))

    expect(c.getTimeline().tracks).toHaveLength(1)
    expect(result.text).toContain('Added a video track')
    expect(events).toContainEqual({ type: 'tool', name: 'add_track', ok: true, error: undefined })
    // The agent edit is tagged agent in the undo history.
    expect(c.snapshot().undoOrigin).toBe('agent')
  })

  it('chains tools, reading ids the previous tool returned', async () => {
    const c = new EditorController()
    let n = 0
    const callModel: ModelCaller = async () => {
      n += 1
      if (n === 1) return toolUse('t1', 'add_track', { type: 'video' })
      if (n === 2) {
        const trackId = c.getTimeline().tracks[0].id
        return toolUse('t2', 'add_clip', { trackId, mediaRef: 'm', startFrame: 0, durationFrames: 60 })
      }
      return say('Built a 60-frame clip.')
    }
    await runAgent(c, [{ role: 'user', content: 'build a clip' }], callModel)
    expect(c.getTimeline().tracks[0].clips).toHaveLength(1)
    expect(c.getTimeline().tracks[0].clips[0].durationFrames).toBe(60)
  })

  it('reports a failing tool and keeps going (no throw)', async () => {
    const c = new EditorController()
    let n = 0
    const callModel: ModelCaller = async () =>
      ++n === 1 ? toolUse('t1', 'add_clip', { trackId: 'x', mediaRef: 'm', startFrame: 0 }) : say('Sorry, that failed.')

    const events: AgentEvent[] = []
    const result = await runAgent(c, [{ role: 'user', content: 'go' }], callModel, (e) => events.push(e))
    expect(events.some((e) => e.type === 'tool' && !e.ok)).toBe(true)
    expect(result.text).toContain('failed')
  })

  it('propagates a model-call failure', async () => {
    const c = new EditorController()
    const callModel: ModelCaller = async () => ({ ok: false, error: 'rate limited' })
    await expect(runAgent(c, [{ role: 'user', content: 'go' }], callModel)).rejects.toThrow(/rate limited/)
  })

  it('stops immediately when the model returns only text', async () => {
    const c = new EditorController()
    let calls = 0
    const callModel: ModelCaller = async () => {
      calls += 1
      return say('Nothing to do.')
    }
    const result = await runAgent(c, [{ role: 'user', content: 'hi' }], callModel)
    expect(calls).toBe(1)
    expect(result.text).toBe('Nothing to do.')
  })
})

describe('anthropicTools', () => {
  it('maps to {name, description, input_schema} and drops $schema', () => {
    const tools = anthropicTools()
    const addClip = tools.find((t) => t.name === 'add_clip')!
    expect(addClip.input_schema).toBeDefined()
    expect(addClip.input_schema.$schema).toBeUndefined()
    expect((addClip.input_schema.properties as Record<string, unknown>).durationFrames).toBeDefined()
  })
})
