// SPDX-License-Identifier: GPL-3.0-or-later
// The in-app AI chat. Edits run through the same EditorController commands as the UI, so the
// timeline and preview update live as the agent works. The API key is BYOK and lives only in main.

import { useEffect, useRef, useState } from 'react'
import { getController } from '../store'
import { type ContentBlock, type MessageParam, type ModelCaller, runAgent } from './agent'
import { runEditorTool } from './runTool'

let nextId = 0
const uid = (): string => `m${nextId++}`

interface ToolChip {
  name: string
  ok: boolean
}
interface ChatItem {
  id: string
  role: 'user' | 'assistant'
  text: string
  tools: ToolChip[]
}

const callModel: ModelCaller = async (req) => {
  const res = await window.editorBridge.aiComplete({ system: req.system, messages: req.messages, tools: req.tools })
  return { ok: res.ok, error: res.error, stopReason: res.stopReason ?? null, content: (res.content ?? []) as ContentBlock[] }
}

export default function ChatPanel(): React.JSX.Element {
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const convoRef = useRef<MessageParam[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void window.editorBridge.aiHasKey().then(setKeyPresent)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [items])

  async function saveKey(): Promise<void> {
    const k = keyInput.trim()
    if (!k) return
    await window.editorBridge.aiSetKey(k)
    setKeyInput('')
    setKeyPresent(await window.editorBridge.aiHasKey())
  }

  async function clearKey(): Promise<void> {
    await window.editorBridge.aiClearKey()
    setKeyPresent(false)
  }

  async function send(): Promise<void> {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setBusy(true)
    const asstId = uid()
    setItems((prev) => [
      ...prev,
      { id: uid(), role: 'user', text, tools: [] },
      { id: asstId, role: 'assistant', text: '', tools: [] }
    ])
    convoRef.current.push({ role: 'user', content: text })

    try {
      const result = await runAgent(
        getController(),
        convoRef.current,
        callModel,
        (e) => {
          if (e.type === 'tool') {
            setItems((prev) => prev.map((it) => (it.id === asstId ? { ...it, tools: [...it.tools, { name: e.name, ok: e.ok }] } : it)))
          }
        },
        runEditorTool
      )
      setItems((prev) => prev.map((it) => (it.id === asstId ? { ...it, text: result.text || '(done)' } : it)))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setItems((prev) => prev.map((it) => (it.id === asstId ? { ...it, text: `⚠ ${msg}` } : it)))
      if (/401|api[\s_-]?key|authentication|x-api-key/i.test(msg)) setKeyPresent(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <aside className="chat">
      <div className="chat-head">
        <h2>AI editor</h2>
        {keyPresent && (
          <button className="link" onClick={() => void clearKey()} title="Remove the stored API key">
            key set ✓
          </button>
        )}
      </div>

      {keyPresent === false ? (
        <div className="chat-key">
          <p className="chat-key-title">Connect your Anthropic API key</p>
          <p className="chat-key-sub">Stored encrypted on this machine (BYOK). It never leaves the app.</p>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
          />
          <button className="primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
            Save key
          </button>
        </div>
      ) : (
        <>
          <div className="chat-log" ref={scrollRef}>
            {items.length === 0 && (
              <div className="chat-empty">
                Ask me to build or edit your timeline — e.g. “add a video track and drop asset X at the start”.
                I’ll call the same editing commands you do.
              </div>
            )}
            {items.map((it) => (
              <div key={it.id} className={`msg ${it.role}`}>
                {it.tools.length > 0 && (
                  <div className="msg-tools">
                    {it.tools.map((t, i) => (
                      <span key={i} className={`tool-chip ${t.ok ? 'ok' : 'err'}`}>
                        {t.ok ? '✓' : '✕'} {t.name}
                      </span>
                    ))}
                  </div>
                )}
                {it.text ? <div className="msg-text">{it.text}</div> : it.role === 'assistant' && busy ? <div className="msg-text dim">thinking…</div> : null}
              </div>
            ))}
          </div>

          <div className="chat-composer">
            <textarea
              placeholder={keyPresent === null ? 'Loading…' : 'Message the AI editor…'}
              value={input}
              disabled={keyPresent === null || busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button className="primary" onClick={() => void send()} disabled={!input.trim() || busy}>
              {busy ? '…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
