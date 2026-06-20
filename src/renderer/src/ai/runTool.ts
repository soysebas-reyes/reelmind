// SPDX-License-Identifier: GPL-3.0-or-later
// Single entry point for executing an AI/MCP tool in the renderer. Timeline tools go straight to the
// pure executeTool; host-only tools (import_media — touches disk + the media bin) are handled here.
// Both the in-app agent and the MCP bridge call this so they behave identically.

import { type ToolCallResult, executeTool } from '@core'
import { getController, useEditorStore } from '../store'

export async function runEditorTool(name: string, input: unknown): Promise<ToolCallResult> {
  if (name === 'import_media') {
    const sources = (input as { sources?: unknown }).sources
    if (!Array.isArray(sources) || sources.length === 0) {
      return { ok: false, error: 'import_media: `sources` must be a non-empty array of paths or URLs' }
    }
    try {
      const imported = await useEditorStore.getState().importFromSources(sources.map(String))
      return {
        ok: true,
        result: {
          assets: imported.map(({ entry }) => ({
            assetId: entry.id,
            name: entry.name,
            type: entry.type,
            durationSeconds: entry.duration
          }))
        }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  return executeTool(getController(), name, input)
}
