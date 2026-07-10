// SPDX-License-Identifier: GPL-3.0-or-later
// The in-app AI chat. Edits run through the same EditorController commands as the UI, so the
// timeline and preview update live as the agent works. The API key is BYOK and lives only in main.

import { useEffect, useRef, useState } from 'react'
import { getController, useEditorStore } from '../store'
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

  const settingsOpen = useEditorStore((s) => s.settingsOpen)

  useEffect(() => {
    // Re-check on Ajustes close too — the key can be saved/cleared from there.
    if (!settingsOpen) void window.editorBridge.aiHasKey().then(setKeyPresent)
  }, [settingsOpen])

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
        <h2>Editor IA</h2>
        {keyPresent && (
          <button
            className="link"
            data-tel="chat.manage_key"
            onClick={() => useEditorStore.getState().setSettingsOpen(true)}
            title="Gestionar la clave de API en Ajustes"
          >
            Clave activa
          </button>
        )}
      </div>

      {keyPresent === false ? (
        <div className="chat-key">
          <p className="chat-key-title">Conecta tu clave de API de Anthropic</p>
          <p className="chat-key-sub">Se guarda cifrada en este equipo (BYOK). Nunca sale de la app.</p>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
          />
          <button className="primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
            Guardar clave
          </button>
        </div>
      ) : (
        <>
          <div className="chat-log" ref={scrollRef}>
            {items.length === 0 && (
              <div className="chat-empty">
                Pídeme construir o editar tu línea de tiempo — p. ej. «agrega una pista de video y coloca el asset X
                al inicio». Ejecuto los mismos comandos de edición que tú.
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
                {it.text ? <div className="msg-text">{it.text}</div> : it.role === 'assistant' && busy ? <div className="msg-text dim">pensando…</div> : null}
              </div>
            ))}
          </div>

          <div className="chat-composer">
            <textarea
              placeholder={keyPresent === null ? 'Cargando…' : 'Escríbele al editor IA…'}
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
              {busy ? '…' : 'Enviar'}
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
