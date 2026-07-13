// SPDX-License-Identifier: GPL-3.0-or-later
// The embedded MCP server: exposes ReelMind's editing tools to external agents (Claude Code /
// Cursor / Claude Desktop) over Streamable HTTP on localhost. It advertises the SAME tool set as
// the in-app agent (from @core) and forwards every tools/call to `execute` — which, in the app,
// proxies to the renderer's EditorController (the single source of truth). `execute` is injected so
// this module is testable in plain Node without Electron.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { ZodObject, ZodRawShape } from 'zod'
import { type ToolCallResult, editorTools, extractToolImage } from '@core'

export interface McpServerHandle {
  url: string
  port: number
  close: () => Promise<void>
}

export interface CreateMcpServerOptions {
  port: number
  host?: string
  execute: (name: string, input: unknown) => Promise<ToolCallResult>
  /** DNS-rebinding protection (on by default). Disable in tests that bind an ephemeral port. */
  enableDnsProtection?: boolean
  /** App version to report (injected by the caller — this module stays Electron-free). */
  version?: string
}

function buildMcpServer(execute: CreateMcpServerOptions['execute'], version?: string): McpServer {
  const mcp = new McpServer({ name: 'reelo', version: version ?? '0.0.0' })
  for (const t of editorTools) {
    const shape = (t.input as ZodObject<ZodRawShape>).shape ?? {}
    mcp.registerTool(t.name, { description: t.description, inputSchema: shape }, async (args: unknown) => {
      const r = await execute(t.name, args)
      // Image-bearing results (get_frame_preview) surface as real MCP image content, so the
      // calling model can SEE the frame instead of receiving base64-as-text.
      const img = r.ok ? extractToolImage(r.result) : null
      if (img) {
        return {
          content: [
            { type: 'image' as const, data: img.image.base64, mimeType: img.image.mimeType },
            { type: 'text' as const, text: JSON.stringify(img.rest) }
          ],
          isError: false
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(r.ok ? (r.result ?? { ok: true }) : { error: r.error }) }],
        isError: !r.ok
      }
    })
  }
  return mcp
}

export async function createMcpHttpServer(opts: CreateMcpServerOptions): Promise<McpServerHandle> {
  const host = opts.host ?? '127.0.0.1'
  const protect = opts.enableDnsProtection ?? true
  const transports = new Map<string, StreamableHTTPServerTransport>()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (req.method === 'POST') {
        let transport = sessionId ? transports.get(sessionId) : undefined
        if (!transport) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: protect,
            allowedHosts: protect
              ? ['127.0.0.1', 'localhost', `127.0.0.1:${opts.port}`, `localhost:${opts.port}`]
              : undefined,
            onsessioninitialized: (sid) => {
              if (transport) transports.set(sid, transport)
            }
          })
          transport.onclose = () => {
            if (transport?.sessionId) transports.delete(transport.sessionId)
          }
          await buildMcpServer(opts.execute, opts.version).connect(transport)
        }
        await transport.handleRequest(req, res, await readJson(req))
      } else if ((req.method === 'GET' || req.method === 'DELETE') && sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res)
      } else {
        res.writeHead(400).end('Invalid MCP request')
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(e instanceof Error ? e.message : String(e))
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(opts.port, host, () => {
      httpServer.removeListener('error', reject)
      resolve()
    })
  })

  const addr = httpServer.address()
  const port = typeof addr === 'object' && addr ? addr.port : opts.port
  return {
    url: `http://${host}:${port}/mcp`,
    port,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve()))
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}
