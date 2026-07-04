// SPDX-License-Identifier: GPL-3.0-or-later
// Take-detection modal, two phases:
//   1) INPUT   — paste the guiones (scripts); "Segmentar con IA" aligns each to the transcript.
//   2) RESULTS — lists ONLY the videos-per-script (title + range), each cut/cleaned automatically.
// "Abrir en pestañas" opens each accepted take as its own editable tab (a cleaned segment); export
// happens later, per tab. Cuts are applied automatically and are NOT shown for selection.

import { useState } from 'react'
import { timelineFrameForSourceSeconds } from '@core'
import type { PlannedTake } from '@core'
import { getController, useEditorStore } from '../store'

/** m:ss.d from ms. */
function mmss(ms: number): string {
  const total = Math.max(0, ms) / 1000
  const m = Math.floor(total / 60)
  const rem = total - m * 60
  return `${m}:${rem.toFixed(1).padStart(4, '0')}`
}

/** Coverage badge state for a take's guión: how much of the pasted script was found in the transcript. */
function coverageBadge(take: PlannedTake): { cls: string; label: string } | null {
  if (!take.coverage) return null
  const pct = Math.round(take.coverage.fraction * 100)
  if (take.coverage.fraction >= 0.95) return { cls: 'ok', label: `Guión hallado ${pct}%` }
  if (take.coverage.fraction >= 0.5) return { cls: 'warn', label: `Guión parcial ${pct}%` }
  if (take.coverage.fraction > 0) return { cls: 'err', label: `Guión ${pct}%` }
  return { cls: 'err', label: 'Guión no encontrado' }
}

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent, #0a84ff)',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit'
}

export function TakesPlanModal(): React.JSX.Element | null {
  const plan = useEditorStore((s) => s.takesPlan)
  const manifest = useEditorStore((s) => s.manifest)
  const inputOpen = useEditorStore((s) => s.takesInputOpen)
  const analyzing = useEditorStore((s) => s.analyzingTakes)
  const setTakeAccepted = useEditorStore((s) => s.setTakeAccepted)
  const analyze = useEditorStore((s) => s.analyzeTakes)
  const apply = useEditorStore((s) => s.applyTakesPlan)
  const dismissPlan = useEditorStore((s) => s.dismissTakesPlan)
  const setInputOpen = useEditorStore((s) => s.setTakesInputOpen)
  const [scripts, setScripts] = useState('')
  const [cleanCuts, setCleanCuts] = useState(false)

  // ── VERIFICATION phase ──────────────────────────────────────────────────────────────────────
  // Show each detected take alongside its pasted guión: coverage (how much of the script was found),
  // whether the start was auto-corrected to the script's first word, and the raw source range (click to
  // preview). Low-coverage takes come pre-unchecked. Confirm what carries over, then open the tabs.
  if (plan) {
    const jumpTo = (ms: number): void => {
      const c = getController()
      const clip = c
        .getTimeline()
        .tracks.flatMap((t) => t.clips)
        .find((x) => x.id === plan.rawClipId)
      if (!clip) return
      const f = timelineFrameForSourceSeconds(clip, ms / 1000, plan.fps)
      if (f != null) c.seek(f)
    }
    const accepted = plan.takeAccepted.filter(Boolean).length
    const lowCoverage = plan.takes.filter((t) => t.coverage && t.coverage.fraction < 0.5).length
    const videosNeedingProxy = manifest.entries.filter((e) => e.type === 'video' && !e.proxyPath).length

    return (
      <div className="modal-backdrop">
        <div className="modal export-modal angleplan-modal" style={{ maxHeight: '92vh' }} onMouseDown={(e) => e.stopPropagation()}>
          <h2>Verificación de guiones</h2>
          <p className="export-note">
            <strong>{plan.takes.length} videos</strong> detectados · revisá que cada guión se haya encontrado completo y que
            empiece desde el inicio. Se abrirán como pestañas editables, ya recortadas y limpias.
          </p>

          {lowCoverage > 0 && (
            <p className="export-note" style={{ color: 'var(--orange)' }}>
              ⚠ {lowCoverage} guión{lowCoverage === 1 ? '' : 'es'} con baja coincidencia — desmarcado{lowCoverage === 1 ? '' : 's'} por
              defecto. Revisá el texto o volvé a segmentar.
            </p>
          )}

          {/* What each new tab inherits, so the user can trust the segments are edit-ready. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '2px 0 10px' }}>
            <span className="pill ok">Color heredado ✓</span>
            <span className="pill ok">Audio mejorado heredado ✓</span>
            <span className={`pill ${videosNeedingProxy > 0 ? 'warn' : 'ok'}`}>
              {videosNeedingProxy > 0
                ? `Reproducción: ${videosNeedingProxy} video(s) sin proxy`
                : 'Reproducción optimizada ✓'}
            </span>
          </div>

          <div className="angleplan-scroll">
            {plan.takes.map((take, ti) => {
              const badge = coverageBadge(take)
              const scriptText = take.scriptIndex != null ? plan.scriptBlocks[take.scriptIndex] : undefined
              return (
                <label
                  key={take.index}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'flex-start',
                    border: '1px solid var(--hairline, #333)',
                    borderRadius: 8,
                    padding: 10,
                    marginBottom: 8,
                    cursor: 'pointer',
                    opacity: plan.takeAccepted[ti] ? 1 : 0.5
                  }}
                >
                  <input
                    type="checkbox"
                    style={{ marginTop: 3 }}
                    checked={plan.takeAccepted[ti]}
                    onChange={(e) => setTakeAccepted(ti, e.target.checked)}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <strong>
                        Video {take.index}: {take.title}
                      </strong>
                      {badge && <span className={`pill ${badge.cls}`}>{badge.label}</span>}
                      {take.startCorrected && <span className="pill ok">Inicio corregido</span>}
                    </div>
                    {take.summary && <p style={{ margin: '4px 0 0', opacity: 0.75 }}>{take.summary}</p>}
                    {scriptText && (
                      <details style={{ marginTop: 6 }}>
                        <summary style={{ cursor: 'pointer', opacity: 0.7, fontSize: 12 }}>Ver guión pegado</summary>
                        <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', opacity: 0.85, fontSize: 12 }}>{scriptText}</p>
                      </details>
                    )}
                  </div>
                  <button
                    style={{ ...linkBtn, flex: '0 0 auto' }}
                    title="Ir a este punto en el crudo"
                    onClick={(e) => {
                      e.preventDefault()
                      jumpTo(take.startMs)
                    }}
                  >
                    {mmss(take.startMs)}–{mmss(take.endMs)} ({mmss(take.endMs - take.startMs)})
                  </button>
                </label>
              )
            })}
          </div>

          <div className="export-actions">
            <button className="primary" disabled={accepted === 0} onClick={() => void apply()}>
              Abrir {accepted} pestaña{accepted === 1 ? '' : 's'}
            </button>
            <button
              onClick={() => {
                dismissPlan()
                setInputOpen(false)
              }}
            >
              Cancelar
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── INPUT phase ─────────────────────────────────────────────────────────────────────────────
  if (inputOpen) {
    return (
      <div className="modal-backdrop">
        <div className="modal export-modal" style={{ maxWidth: 640 }} onMouseDown={(e) => e.stopPropagation()}>
          <h2>Segmentar por guiones</h2>
          <p className="export-note">
            Pegá los guiones que grabaste (uno por bloque, separados por una línea en blanco). La IA busca cada guión
            en la transcripción y arma un video por guión. Si lo dejás vacío, detecta las tomas sola.
          </p>
          <textarea
            value={scripts}
            onChange={(e) => setScripts(e.target.value)}
            placeholder={'Guión 1...\n\nGuión 2...\n\nGuión 3...'}
            spellCheck={false}
            style={{
              width: '100%',
              minHeight: 240,
              resize: 'vertical',
              fontFamily: 'inherit',
              fontSize: 13,
              lineHeight: 1.5,
              padding: 10,
              boxSizing: 'border-box'
            }}
          />
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              marginTop: 14,
              padding: 12,
              border: '1px solid var(--hairline, #333)',
              borderRadius: 8,
              cursor: 'pointer'
            }}
          >
            <input type="checkbox" style={{ marginTop: 2 }} checked={cleanCuts} onChange={(e) => setCleanCuts(e.target.checked)} />
            <div>
              <strong>Cortar muletillas, repeticiones y silencios</strong>
              <p style={{ margin: '3px 0 0', opacity: 0.7, fontSize: 12.5 }}>
                {cleanCuts
                  ? 'Experimental: la IA intentará limpiar cada guión (todavía en ajuste).'
                  : 'Apagado: trae el fragmento completo de cada guión, tal como se grabó (con repeticiones, sin cortes).'}
              </p>
            </div>
          </label>
          <div className="export-actions">
            <button
              className="primary"
              disabled={analyzing}
              onClick={() => void analyze(undefined, scripts.trim() || undefined, cleanCuts)}
            >
              {analyzing ? 'Segmentando…' : 'Segmentar con IA'}
            </button>
            <button disabled={analyzing} onClick={() => setInputOpen(false)}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}
