// SPDX-License-Identifier: GPL-3.0-or-later
// Bridges an MCP tools/call (handled in main) to the renderer's EditorController, which owns the
// live timeline. Main sends an execute request to the focused window; the renderer runs executeTool
// and replies with the result (request/response correlated by id). This is the "option (a)" proxy.

import { BrowserWindow, ipcMain } from 'electron'
import type { ToolCallResult } from '@core'

const pending = new Map<string, (r: ToolCallResult) => void>()
let counter = 0
let installed = false

function ensureInstalled(): void {
  if (installed) return
  installed = true
  ipcMain.on('mcp:execute:result', (_e, payload: { requestId: string; result: ToolCallResult }) => {
    const resolve = pending.get(payload.requestId)
    if (resolve) {
      pending.delete(payload.requestId)
      resolve(payload.result)
    }
  })
}

export function executeToolInRenderer(name: string, input: unknown, timeoutMs = 15_000): Promise<ToolCallResult> {
  ensureInstalled()
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || win.webContents.isDestroyed()) {
    return Promise.resolve({ ok: false, error: 'No editor window is open' })
  }
  const requestId = `mcp-${++counter}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      resolve({ ok: false, error: 'Tool execution timed out' })
    }, timeoutMs)
    pending.set(requestId, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    win.webContents.send('mcp:execute', { requestId, name, input })
  })
}
