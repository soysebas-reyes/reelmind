// SPDX-License-Identifier: GPL-3.0-or-later
// Integration test: a real MCP client connects to the embedded HTTP server over the wire and
// lists + calls tools. The "renderer" executor is injected (a real EditorController), so this
// verifies the full transport + tool registration without Electron.

import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EditorController, type ToolCallResult, executeTool } from '@core'
import { createMcpHttpServer } from './server'

interface CallResult {
  content: { type: string; text?: string }[]
  isError?: boolean
}
const firstText = (r: CallResult): unknown => JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}')

describe('embedded MCP HTTP server', () => {
  it('lists the editor tools and executes them against the controller', async () => {
    const controller = new EditorController()
    const execute = (name: string, input: unknown): Promise<ToolCallResult> =>
      Promise.resolve(executeTool(controller, name, input))

    const handle = await createMcpHttpServer({ port: 0, enableDnsProtection: false, execute })
    const client = new Client({ name: 'reelo-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(handle.url))

    try {
      await client.connect(transport)

      const tools = await client.listTools()
      const names = tools.tools.map((t) => t.name)
      expect(names).toContain('add_track')
      expect(names).toContain('add_clip')
      expect(names).toContain('get_timeline')

      const added = (await client.callTool({ name: 'add_track', arguments: { type: 'video' } })) as CallResult
      expect(added.isError).toBeFalsy()
      const trackId = (firstText(added) as { trackId?: string }).trackId
      expect(trackId).toBeTruthy()
      expect(controller.getTimeline().tracks).toHaveLength(1)

      await client.callTool({ name: 'add_clip', arguments: { trackId, mediaRef: 'm', startFrame: 0, durationFrames: 60 } })
      expect(controller.getTimeline().tracks[0].clips).toHaveLength(1)

      const summary = firstText((await client.callTool({ name: 'get_timeline', arguments: {} })) as CallResult)
      expect((summary as { totalFrames: number }).totalFrames).toBe(60)

      // Validation errors surface as MCP tool errors, not crashes.
      const bad = (await client.callTool({ name: 'add_clip', arguments: { trackId } })) as CallResult
      expect(bad.isError).toBe(true)
    } finally {
      await client.close().catch(() => {})
      await handle.close()
    }
  }, 30_000)
})

describe('embedded MCP HTTP server — image content', () => {
  it('surfaces image-bearing tool results as MCP image content blocks', async () => {
    const controller = new EditorController()
    // Injected executor: get_frame_preview answers with the image sentinel (as the renderer would).
    const execute = (name: string, input: unknown): Promise<ToolCallResult> => {
      if (name === 'get_frame_preview') {
        return Promise.resolve({
          ok: true,
          result: { frame: 30, width: 640, height: 360, image: { mimeType: 'image/jpeg', base64: 'aGVsbG8=' } }
        })
      }
      return Promise.resolve(executeTool(controller, name, input))
    }

    const handle = await createMcpHttpServer({ port: 0, enableDnsProtection: false, execute })
    const client = new Client({ name: 'reelo-test', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(handle.url))
    try {
      await client.connect(transport)
      const r = (await client.callTool({ name: 'get_frame_preview', arguments: {} })) as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[]
        isError?: boolean
      }
      expect(r.isError).toBeFalsy()
      const img = r.content.find((c) => c.type === 'image')
      expect(img?.data).toBe('aGVsbG8=')
      expect(img?.mimeType).toBe('image/jpeg')
      const rest = JSON.parse(r.content.find((c) => c.type === 'text')?.text ?? '{}') as { frame: number }
      expect(rest.frame).toBe(30)
    } finally {
      await client.close().catch(() => {})
      await handle.close()
    }
  }, 30_000)
})
