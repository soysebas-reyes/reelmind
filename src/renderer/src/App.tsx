import { useEffect, useState } from 'react'

type PingResult = {
  ok: boolean
  versions: { electron: string; chrome: string; node: string }
}

const ROADMAP: { phase: string; label: string; state: 'done' | 'active' | 'todo' }[] = [
  { phase: 'P0', label: 'Repo + scaffold', state: 'active' },
  { phase: 'P1', label: 'Editor: import + media bin', state: 'todo' },
  { phase: 'P2', label: 'Editor: timeline editing', state: 'todo' },
  { phase: 'P3', label: 'Editor: real-time preview', state: 'todo' },
  { phase: 'P4', label: 'Editor: FFmpeg export', state: 'todo' },
  { phase: 'P5', label: 'AI: agent contract + chat (BYOK)', state: 'todo' },
  { phase: 'P6', label: 'AI: MCP server (Claude Code / Cursor)', state: 'todo' },
  { phase: 'P7', label: 'Generation: Higgs Field', state: 'todo' },
  { phase: 'P8', label: 'More providers + Windows installer', state: 'todo' }
]

export default function App() {
  const [ping, setPing] = useState<PingResult | null>(null)
  const [bridgeError, setBridgeError] = useState<string | null>(null)

  useEffect(() => {
    window.editorBridge
      ?.ping()
      .then(setPing)
      .catch((e) => setBridgeError(String(e)))
  }, [])

  return (
    <div className="shell">
      <header className="hero">
        <h1>ReelMind</h1>
        <p className="tagline">
          You and your agent generate and edit video together, on the timeline — for Windows.
        </p>
        <p className="attribution">
          Independent open&#8209;source derivative of{' '}
          <strong>palmier&#8209;io/palmier&#8209;pro</strong> (macOS) · GPL&#8209;3.0
        </p>
      </header>

      <section className="card">
        <h2>Environment bridge</h2>
        {ping ? (
          <ul className="kv">
            <li>
              <span>status</span>
              <code className="ok">main ↔ preload ↔ renderer OK</code>
            </li>
            <li>
              <span>electron</span>
              <code>{ping.versions.electron}</code>
            </li>
            <li>
              <span>chromium</span>
              <code>{ping.versions.chrome}</code>
            </li>
            <li>
              <span>node</span>
              <code>{ping.versions.node}</code>
            </li>
          </ul>
        ) : bridgeError ? (
          <code className="err">bridge error: {bridgeError}</code>
        ) : (
          <code className="muted">contacting main process…</code>
        )}
      </section>

      <section className="card">
        <h2>Build roadmap</h2>
        <ol className="roadmap">
          {ROADMAP.map((r) => (
            <li key={r.phase} className={r.state}>
              <span className="ph">{r.phase}</span>
              <span className="lbl">{r.label}</span>
              <span className="dot" aria-hidden />
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
