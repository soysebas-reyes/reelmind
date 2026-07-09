// SPDX-License-Identifier: GPL-3.0-or-later
// Take-detection modal, two phases:
//   1) INPUT   — paste the guiones (scripts); "Segmentar con IA" aligns each to the transcript.
//   2) RESULTS — lists ONLY the videos-per-script (title + range), each cut/cleaned automatically.
// "Abrir en pestañas" opens each accepted take as its own editable tab (a cleaned segment); export
// happens later, per tab. Cuts are applied automatically and are NOT shown for selection.

import { useState } from 'react'
import { findUnsyncedAnglePair, timelineFrameForSourceSeconds } from '@core'
import type { PlannedTake } from '@core'
import { getController, useEditorStore } from '../store'
import { CutList } from './CutList'
import { TakesPreview } from './TakesPreview'
import { mmss } from './format'

/** True when a take is a "no encontrado con confianza" placeholder (recovered guión with no real match). */
function isNotFound(take: PlannedTake): boolean {
  return !!take.reconstructed && (!take.coverage || take.coverage.fraction === 0)
}

/** Coverage badge state for a take's guión: how much of the pasted script was found in the transcript. */
function coverageBadge(take: PlannedTake): { cls: string; label: string } | null {
  if (isNotFound(take)) return { cls: 'err', label: 'No encontrado — ajustá los límites' }
  if (!take.coverage) return take.reconstructed ? { cls: 'warn', label: 'Recuperado — revisá' } : null
  const pct = Math.round(take.coverage.fraction * 100)
  if (take.coverage.fraction >= 0.95) return { cls: 'ok', label: `Guión hallado ${pct}%` }
  if (take.coverage.fraction >= 0.5) return { cls: 'warn', label: `Guión parcial ${pct}%` }
  return { cls: 'warn', label: `Revisá los límites ${pct}%` }
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
  const timeline = useEditorStore((s) => s.timeline)
  const inputOpen = useEditorStore((s) => s.takesInputOpen)
  const analyzing = useEditorStore((s) => s.analyzingTakes)
  const setTakeAccepted = useEditorStore((s) => s.setTakeAccepted)
  const analyze = useEditorStore((s) => s.analyzeTakes)
  const apply = useEditorStore((s) => s.applyTakesPlan)
  const dismissPlan = useEditorStore((s) => s.dismissTakesPlan)
  const setInputOpen = useEditorStore((s) => s.setTakesInputOpen)
  const [scripts, setScripts] = useState('')
  const [cleanCuts, setCleanCuts] = useState(false)
  // "Aire" entre frases (ms de silencio conservado por corte). Natural por defecto.
  const [airMs, setAirMs] = useState(250)
  // Whose audio the pre-segmentation auto-sync keeps (only shown when 2 unsynced angles exist).
  const [keepAudioClipId, setKeepAudioClipId] = useState<string | undefined>(undefined)

  /** Bin name of the media behind a timeline clip (for the "Audio de:" selector). */
  const clipLabel = (clipId: string): string => {
    const clip = timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
    const entry = clip && manifest.entries.find((e) => e.id === clip.mediaRef)
    return entry?.name ?? 'Clip'
  }

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
    const notFound = plan.takes.filter((t) => isNotFound(t)).length
    const lowCoverage = plan.takes.filter((t) => !isNotFound(t) && t.coverage && t.coverage.fraction < 0.5).length
    const videosNeedingProxy = manifest.entries.filter((e) => e.type === 'video' && !e.proxyPath).length

    return (
      <div className="modal-backdrop">
        <div className="modal export-modal angleplan-modal" style={{ maxHeight: '92vh', width: 'min(1180px, 96vw)' }} onMouseDown={(e) => e.stopPropagation()}>
          <h2>Verificación de guiones</h2>
          <p className="export-note">
            <strong>{plan.takes.length} videos</strong> detectados · revisá que cada guión se haya encontrado completo y que
            empiece desde el inicio. Se abrirán como pestañas editables, ya recortadas y limpias.
          </p>

          {notFound > 0 && (
            <p className="export-note" style={{ color: 'var(--orange)' }}>
              ⚠ {notFound} guión{notFound === 1 ? '' : 'es'} no se encontr{notFound === 1 ? 'ó' : 'aron'} con confianza —
              qued{notFound === 1 ? 'ó' : 'aron'} en su posición aproximada para que ajustes los límites en la vista previa
              (desmarcad{notFound === 1 ? 'o' : 'os'}: marcá para abrirl{notFound === 1 ? 'o' : 'os'}).
            </p>
          )}
          {lowCoverage > 0 && (
            <p className="export-note" style={{ color: 'var(--orange)' }}>
              {lowCoverage} guión{lowCoverage === 1 ? '' : 'es'} con coincidencia parcial — revisá los límites antes de abrir.
            </p>
          )}

          {/* What each new tab inherits, so the user can trust the segments are edit-ready. */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '2px 0 10px' }}>
            {plan.autoSync?.applied && (
              <span
                className="pill ok"
                title="Se detectaron 2 ángulos sin sincronizar y se alinearon por audio antes de segmentar."
              >
                Sincronizado automáticamente ({plan.autoSync.offsetSeconds?.toFixed(2)} s ·{' '}
                {plan.autoSync.method === 'transcript' ? 'palabras' : 'correlación'}) ✓
              </span>
            )}
            {plan.autoSync?.warning && <span className="pill warn">⚠ {plan.autoSync.warning}</span>}
            <span className="pill ok">Color heredado ✓</span>
            <span className="pill ok">Audio mejorado heredado ✓</span>
            <span className={`pill ${videosNeedingProxy > 0 ? 'warn' : 'ok'}`}>
              {videosNeedingProxy > 0
                ? `Reproducción: ${videosNeedingProxy} video(s) sin proxy`
                : 'Reproducción optimizada ✓'}
            </span>
          </div>

          {/* Two columns: the selection checklist on the LEFT (the player was eating its vertical space),
              the editable preview on the RIGHT where the horizontal room helps most. */}
          <div className="takes-verify-body">
            <div className="takes-verify-list angleplan-scroll">
            {plan.takes.map((take, ti) => {
              const badge = coverageBadge(take)
              const scriptText = take.scriptIndex != null ? plan.scriptBlocks[take.scriptIndex] : undefined
              return (
                <div key={take.index} className="takes-verify-take" style={{ opacity: plan.takeAccepted[ti] ? 1 : 0.5 }}>
                  {/* The take checkbox lives in its own <label>; the CutList checkboxes sit OUTSIDE it so
                      toggling a cut never toggles the whole take. */}
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      style={{ marginTop: 3 }}
                      checked={plan.takeAccepted[ti]}
                      onChange={(e) => setTakeAccepted(ti, e.target.checked)}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <strong>
                          {take.guionNumber != null ? `Guión ${take.guionNumber}` : `Video ${take.index}`}: {take.title}
                        </strong>
                        {take.edited ? (
                          <span className="pill" style={{ background: 'var(--fill-2)', color: 'var(--label-2)' }} title="Los tiempos fueron ajustados a mano; la coincidencia del guión ya no aplica.">
                            Ajustado manualmente
                          </span>
                        ) : (
                          <>
                            {badge && <span className={`pill ${badge.cls}`}>{badge.label}</span>}
                            {take.startCorrected && <span className="pill ok">Inicio corregido</span>}
                          </>
                        )}
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
                  <CutList takeIndex={take.index} />
                </div>
              )
            })}
            </div>
            <div className="takes-verify-main">
              <p className="export-note" style={{ textAlign: 'left', margin: '0 0 6px' }}>
                Ajustá con criterio los límites de cada guión: arrastrá los bordes de cada bloque de color, o usá los
                campos de tiempo y “usar posición actual”.
              </p>
              <TakesPreview />
            </div>
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
    // Multicam state: with 2 raw (unlinked, overlapping) angles the segmentation auto-syncs first,
    // so surface that here + let the user pick whose audio survives (default: top track = frontal).
    const scan = findUnsyncedAnglePair(timeline)
    return (
      <div className="modal-backdrop">
        <div className="modal export-modal" style={{ maxWidth: 640 }} onMouseDown={(e) => e.stopPropagation()}>
          <h2>Segmentar por guiones</h2>
          <p className="export-note">
            Pegá los guiones que grabaste (uno por bloque, separados por una línea en blanco). La IA busca cada guión
            en la transcripción y arma un video por guión. Si lo dejás vacío, detecta las tomas sola.
          </p>
          {scan.kind === 'pair' && (
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
                margin: '0 0 10px',
                padding: 10,
                border: '1px solid var(--hairline, #333)',
                borderRadius: 8
              }}
            >
              <span style={{ fontSize: 12.5 }}>
                🎬 Se detectaron <strong>2 ángulos sin sincronizar</strong>: se sincronizarán automáticamente antes de
                segmentar. Audio de:
              </span>
              <select
                data-tel="takes.keep_audio"
                value={keepAudioClipId ?? scan.frontalClipId}
                onChange={(e) => setKeepAudioClipId(e.target.value)}
                style={{ font: 'inherit', fontSize: 12.5 }}
              >
                <option value={scan.frontalClipId}>{clipLabel(scan.frontalClipId)} (pista superior)</option>
                <option value={scan.lateralClipId}>{clipLabel(scan.lateralClipId)} (pista inferior)</option>
              </select>
            </div>
          )}
          {scan.kind === 'ambiguous' && (
            <p className="export-note" style={{ color: 'var(--orange)', margin: '0 0 10px' }}>
              ⚠ Hay ángulos de video sin sincronizar ({scan.reason}). Para mejores resultados usá{' '}
              <strong>Sincronizar</strong> antes de segmentar; igual podés continuar.
            </p>
          )}
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
            <input type="checkbox" data-tel="takes.clean_cuts" style={{ marginTop: 2 }} checked={cleanCuts} onChange={(e) => setCleanCuts(e.target.checked)} />
            <div>
              <strong>Cortar muletillas, repeticiones y silencios</strong>
              <p style={{ margin: '3px 0 0', opacity: 0.7, fontSize: 12.5 }}>
                {cleanCuts
                  ? 'Corte agresivo (ritmo reels): muletillas, silencios, tartamudeos y repeticiones. Revisás y desmarcás cada corte antes de aplicar.'
                  : 'Apagado: trae el fragmento completo de cada guión, tal como se grabó (con repeticiones, sin cortes).'}
              </p>
            </div>
          </label>
          {cleanCuts && (
            <label
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
                marginTop: 8,
                padding: '8px 12px',
                border: '1px solid var(--hairline, #333)',
                borderRadius: 8
              }}
            >
              <span style={{ fontSize: 12.5 }}>
                <strong>Aire entre frases</strong> (silencio que se conserva al cortar):
              </span>
              <select
                data-tel="takes.air"
                value={airMs}
                onChange={(e) => setAirMs(Number(e.target.value))}
                style={{ font: 'inherit', fontSize: 12.5 }}
              >
                <option value={120}>Ajustado (rápido)</option>
                <option value={250}>Natural</option>
                <option value={450}>Relajado (respirado)</option>
              </select>
            </label>
          )}
          <div className="export-actions">
            <button
              className="primary"
              disabled={analyzing}
              onClick={() =>
                void analyze(undefined, scripts.trim() || undefined, cleanCuts, {
                  keepAudioClipId: scan.kind === 'pair' ? (keepAudioClipId ?? scan.frontalClipId) : undefined,
                  airMs
                })
              }
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
