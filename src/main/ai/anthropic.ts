// SPDX-License-Identifier: GPL-3.0-or-later
// Thin authenticated proxy to the Anthropic Messages API. The key is read here (main) and never
// exposed to the renderer; the renderer orchestrates the tool loop and calls this once per turn.

import Anthropic from '@anthropic-ai/sdk'
import type { AiCompleteRequest, AiCompleteResponse } from '../../shared/ipc'
import { getApiKey } from './secrets'

export const DEFAULT_MODEL = 'claude-sonnet-4-6'

export async function complete(req: AiCompleteRequest): Promise<AiCompleteResponse> {
  const apiKey = await getApiKey()
  if (!apiKey) return { ok: false, error: 'No Anthropic API key set. Add one in the AI panel.' }

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model: req.model || DEFAULT_MODEL,
      max_tokens: req.maxTokens ?? 2048,
      system: req.system,
      messages: req.messages,
      tools: req.tools
    } as unknown as Anthropic.MessageCreateParamsNonStreaming)
    return { ok: true, stopReason: msg.stop_reason, content: msg.content }
  } catch (e) {
    const err = e as { status?: number; message?: string }
    const detail = err.status ? `(${err.status}) ${err.message ?? ''}`.trim() : err.message ?? String(e)
    return { ok: false, error: detail }
  }
}
