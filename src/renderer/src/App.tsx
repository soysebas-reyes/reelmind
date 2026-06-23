// SPDX-License-Identifier: GPL-3.0-or-later
import { type CSSProperties, useEffect, useState } from 'react'
import { type ClipType, type MediaManifestEntry } from '@core'
import type { ExportQuality } from '../../shared/ipc'
import { getController, useEditorStore } from './store'
import Timeline from './timeline/Timeline'
import Preview from './preview/Preview'
import ChatPanel from './ai/ChatPanel'
import ColorInspector from './color/ColorInspector'

const RESOLUTIONS: { label: string; w: number; h: number }[] = [
  { label: '1920×1080 (16:9)', w: 1920, h: 1080 },
  { label: '1080×1920 (9:16)', w: 1080, h: 1920 },
  { label: '1280×720 (16:9)', w: 1280, h: 720 },
  { label: '3840×2160 (4K)', w: 3840, h: 2160 },
  { label: '1080×1080 (1:1)', w: 1080, h: 1080 }
]
const FPS_OPTIONS = [24, 25, 30, 50, 60]
const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'high', label: 'Alta' },
  { value: 'veryHigh', label: 'Muy alta' },
  { value: 'max', label: 'Máxima (sin pérdida visual)' }
]

const TYPE_GLYPH: Record<ClipType, string> = {
  video: '🎬',
  audio: '🎵',
  image: '🖼️',
  text: 'T',
  lottie: '✨'
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function AssetCard({ entry, thumbnail }: { entry: MediaManifestEntry; thumbnail: string | null }) {
  return (
    <div
      className="asset"
      title={`${entry.name} — drag onto the timeline`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-reelmind-asset', entry.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className="asset-thumb">
        {thumbnail ? (
          <img src={thumbnail} alt={entry.name} draggable={false} />
        ) : (
          <span className="asset-thumb-glyph">{TYPE_GLYPH[entry.type]}</span>
        )}
        <span className="asset-type">{entry.type}</span>
      </div>
      <div className="asset-name">{entry.name}</div>
      <div className="asset-meta">
        {entry.type !== 'image' && <span>{formatDuration(entry.duration)}</span>}
        {entry.sourceWidth && entry.sourceHeight && (
          <span>
            {entry.sourceWidth}×{entry.sourceHeight}
          </span>
        )}
        {entry.sourceFPS ? <span>{Math.round(entry.sourceFPS)}fps</span> : null}
        {entry.type === 'video' && <span>{entry.hasAudio ? '🔊' : '🔇'}</span>}
      </div>
    </div>
  )
}

/** A thin draggable divider that reports incremental pointer deltas along one axis. */
function ResizeHandle({ axis, onResize }: { axis: 'x' | 'y'; onResize: (delta: number) => void }): React.JSX.Element {
  function onPointerDown(e: React.PointerEvent): void {
    e.preventDefault()
    let last = axis === 'x' ? e.clientX : e.clientY
    const move = (ev: PointerEvent): void => {
      const pos = axis === 'x' ? ev.clientX : ev.clientY
      onResize(pos - last)
      last = pos
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={`resize-handle ${axis}`} onPointerDown={onPointerDown} role="separator" />
}

const clampPx = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

interface Layout {
  binW: number
  chatW: number
  timelineH: number
}

function loadLayout(): Layout {
  try {
    const s = JSON.parse(localStorage.getItem('reelmind.layout') || '{}') as Partial<Layout>
    return { binW: s.binW ?? 296, chatW: s.chatW ?? 330, timelineH: s.timelineH ?? 320 }
  } catch {
    return { binW: 296, chatW: 330, timelineH: 320 }
  }
}

export default function App() {
  const {
    projectName,
    projectDir,
    timeline,
    manifest,
    thumbnails,
    ffmpeg,
    busy,
    dirty,
    lastError,
    canUndo,
    canRedo,
    undoLabel,
    redoLabel,
    selectedClipIds,
    init,
    newProject,
    importFiles,
    saveProject,
    openProject,
    exportProject,
    setResolution,
    setFps,
    exportQuality,
    setExportQuality,
    exportProgress,
    exportResult,
    dismissExportResult,
    revealExport,
    extractAudioFromClip,
    analyzeSyncForSelection,
    applySyncAngles,
    dismissSyncResult,
    syncBusy,
    syncResult,
    transcribing,
    transcript,
    transcribeClip,
    clearTranscript,
    exportTranscriptSrt
  } = useEditorStore()

  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [colorOpen, setColorOpen] = useState(false)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  // Sync confirmation modal options (frontal/lateral swap, which audio to keep, per-angle color).
  const [syncSwap, setSyncSwap] = useState(false)
  const [syncKeepAudio, setSyncKeepAudio] = useState<'frontal' | 'lateral'>('frontal')
  const [syncAutoColor, setSyncAutoColor] = useState(true)
  useEffect(() => {
    localStorage.setItem('reelmind.layout', JSON.stringify(layout))
  }, [layout])

  useEffect(() => {
    void init()
  }, [init])

  // Debounced autosave once the project has a location on disk.
  useEffect(() => {
    if (!dirty || !projectDir) return
    const t = setTimeout(() => void saveProject(), 1500)
    return () => clearTimeout(t)
  }, [dirty, projectDir, timeline, manifest, saveProject])

  const ffmpegOk = ffmpeg?.ffmpeg && ffmpeg?.ffprobe

  // Multicam actions key off how many *video* clips are selected.
  const selectedVideoIds = selectedClipIds.filter((id) => getController().getClip(id)?.mediaType === 'video')
  const canExtractAudio = selectedVideoIds.length === 1
  const canSyncAngles = selectedVideoIds.length === 2
  const canDeleteTrack = selectedClipIds.length > 0
  const selectedTrackId: string | null = (() => {
    if (selectedClipIds.length === 0) return null
    const id = selectedClipIds[0]
    return timeline.tracks.find((t) => t.clips.some((c) => c.id === id))?.id ?? null
  })()
  const canTranscribe = selectedVideoIds.length >= 1
  const clipDisplayName = (clipId?: string): string => {
    if (!clipId) return ''
    const clip = getController().getClip(clipId)
    return (clip && manifest.entries.find((x) => x.id === clip.mediaRef)?.name) || 'Clip'
  }
  const syncFrontalId = syncSwap ? syncResult?.lateralClipId : syncResult?.frontalClipId
  const syncLateralId = syncSwap ? syncResult?.frontalClipId : syncResult?.lateralClipId

  return (
    <div className="app">
      <header className="app-header">
        {/* Row 1: brand + project settings */}
        <div className="topbar">
          <div className="brand">
            <span className="logo">ReelMind</span>
            <span className="proj">
              {projectName}
              {dirty && <span className="dot" title="Cambios sin guardar" />}
            </span>
          </div>
          <div className="settings">
            <label>
              Resolución
              <select
                value={`${timeline.width}×${timeline.height}`}
                onChange={(e) => {
                  const r = RESOLUTIONS.find((x) => `${x.w}×${x.h}` === e.target.value)
                  if (r) setResolution(r.w, r.h)
                }}
              >
                {RESOLUTIONS.every((r) => `${r.w}×${r.h}` !== `${timeline.width}×${timeline.height}`) && (
                  <option value={`${timeline.width}×${timeline.height}`}>
                    {timeline.width}×{timeline.height}
                  </option>
                )}
                {RESOLUTIONS.map((r) => (
                  <option key={r.label} value={`${r.w}×${r.h}`}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              FPS
              <select value={timeline.fps} onChange={(e) => setFps(Number(e.target.value))}>
                {FPS_OPTIONS.every((f) => f !== timeline.fps) && <option value={timeline.fps}>{timeline.fps}</option>}
                {FPS_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Calidad
              <select value={exportQuality} onChange={(e) => setExportQuality(e.target.value as ExportQuality)}>
                {QUALITY_OPTIONS.map((q) => (
                  <option key={q.value} value={q.value}>
                    {q.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Row 2: action toolbar */}
        <div className="toolbar">
          <button onClick={() => getController().undo()} disabled={!canUndo} title={undoLabel ? `Deshacer: ${undoLabel}` : 'Deshacer'}>
            ↶ Deshacer
          </button>
          <button onClick={() => getController().redo()} disabled={!canRedo} title={redoLabel ? `Rehacer: ${redoLabel}` : 'Rehacer'}>
            ↷ Rehacer
          </button>
          <span className="tl-sep" />
          <button onClick={newProject} title="Nuevo proyecto">Nuevo</button>
          <button onClick={() => void openProject()} title="Abrir proyecto">Abrir</button>
          <button className="primary" onClick={() => void saveProject()} disabled={!dirty && !!projectDir} title="Guardar proyecto">
            Guardar
          </button>
          <button onClick={() => void exportProject()} disabled={!!busy || timeline.tracks.length === 0} title="Exportar a MP4">
            Exportar
          </button>
          <span className="tl-sep" />
          <button
            onClick={() => setColorOpen(true)}
            disabled={selectedClipIds.length === 0}
            title={selectedClipIds.length === 0 ? 'Selecciona un clip para colorizar' : 'Abrir explorador de colorización'}
          >
            🎨 Color
          </button>
          <button
            onClick={() => { const id = selectedVideoIds[0]; if (id) void extractAudioFromClip(id) }}
            disabled={!canExtractAudio || !!busy}
            title={canExtractAudio ? 'Extraer audio a un asset nuevo' : 'Selecciona un solo clip de video'}
          >
            🎙️ Audio
          </button>
          <button
            onClick={() => { setSyncSwap(false); setSyncKeepAudio('frontal'); setSyncAutoColor(true); void analyzeSyncForSelection() }}
            disabled={!canSyncAngles || !!busy || syncBusy}
            title={canSyncAngles ? 'Sincronizar 2 ángulos por audio' : 'Selecciona exactamente 2 clips de video'}
          >
            🎬 Sincronizar
          </button>
          <button
            onClick={() => {
              if (transcript) { setTranscriptOpen(true); return }
              if (canTranscribe) { void transcribeClip(selectedVideoIds[0]); setTranscriptOpen(true) }
            }}
            disabled={(!canTranscribe && !transcript) || !!busy || transcribing}
            title={transcript ? 'Ver transcript' : canTranscribe ? 'Transcribir con ElevenLabs' : 'Selecciona un clip de video'}
            className={transcript ? 'toolbar-active' : ''}
          >
            {transcribing ? '⏳ …' : transcript ? '📄 Transcript' : '📝 Transcribir'}
          </button>
          <span className="tl-sep" />
          <button
            onClick={() => { if (selectedTrackId) getController().removeTrack(selectedTrackId) }}
            disabled={!canDeleteTrack}
            title={canDeleteTrack ? 'Eliminar la pista del clip seleccionado (y todos sus clips)' : 'Selecciona un clip primero'}
            className={canDeleteTrack ? 'toolbar-danger' : ''}
          >
            🗑️ Pista
          </button>
        </div>
      </header>

      <div className="workspace" style={{ '--timeline-h': `${layout.timelineH}px` } as CSSProperties}>
        <div className="stage" style={{ '--bin-w': `${layout.binW}px`, '--chat-w': `${layout.chatW}px` } as CSSProperties}>
          <section className="bin">
            <div className="bin-head">
              <h2>Media bin</h2>
              <button className="primary" onClick={() => void importFiles()} disabled={!!busy}>
                + Import
              </button>
            </div>

            {manifest.entries.length === 0 ? (
              <div className="empty">
                <p className="empty-title">No media yet</p>
                <p className="empty-sub">Import video, audio, or images, then drag them onto the timeline.</p>
                <button className="primary" onClick={() => void importFiles()}>
                  + Import media
                </button>
              </div>
            ) : (
              <div className="grid">
                {manifest.entries.map((entry) => (
                  <AssetCard key={entry.id} entry={entry} thumbnail={thumbnails[entry.id] ?? null} />
                ))}
              </div>
            )}
          </section>

          <ResizeHandle axis="x" onResize={(d) => setLayout((l) => ({ ...l, binW: clampPx(l.binW + d, 200, 560) }))} />
          <Preview />
          <ResizeHandle axis="x" onResize={(d) => setLayout((l) => ({ ...l, chatW: clampPx(l.chatW - d, 240, 620) }))} />
          <ChatPanel />
        </div>

        <ResizeHandle axis="y" onResize={(d) => setLayout((l) => ({ ...l, timelineH: clampPx(l.timelineH - d, 140, 760) }))} />
        <Timeline />
      </div>

      <footer className="statusbar">
        <span className={`pill ${ffmpegOk ? 'ok' : 'warn'}`}>
          {ffmpegOk ? `FFmpeg ready` : 'FFmpeg not found — install it and restart'}
        </span>
        {busy && <span className="busy">{busy}</span>}
        {lastError && <span className="err">{lastError}</span>}
        <span className="spacer" />
        <span className="credit">
          {manifest.entries.length} asset{manifest.entries.length === 1 ? '' : 's'} · derivative of palmier-io/palmier-pro
          · GPL-3.0
        </span>
      </footer>

      {colorOpen && (
        <div className="modal-backdrop" onMouseDown={() => setColorOpen(false)}>
          <div className="modal color-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Colorización</h2>
              <button className="modal-close" onClick={() => setColorOpen(false)} title="Cerrar">
                ✕
              </button>
            </div>
            <ColorInspector onClose={() => setColorOpen(false)} />
          </div>
        </div>
      )}

      {/* Blocking export overlay: a long render must finish before the .mp4 is playable, so we show
          real progress and explicitly tell the user not to open the file / close the app until done. */}
      {exportProgress !== null && (
        <div className="modal-backdrop">
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="spinner" />
            <h2>Exportando tu video…</h2>
            <div className="export-bar">
              <div className="export-bar-fill" style={{ width: `${Math.round(exportProgress * 100)}%` }} />
            </div>
            <p className="export-pct">{Math.round(exportProgress * 100)}%</p>
            <p className="export-note">
              Puede tardar varios minutos en videos largos o en alta calidad. No cierres la app; el archivo
              no se podrá reproducir hasta que termine.
            </p>
          </div>
        </div>
      )}

      {exportResult && (
        <div className="modal-backdrop" onMouseDown={() => dismissExportResult()}>
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            {exportResult.ok ? (
              <>
                <div className="export-check">✓</div>
                <h2>Exportación completa</h2>
                <p className="export-path" title={exportResult.outputPath}>
                  {exportResult.outputPath}
                </p>
                <div className="export-actions">
                  {exportResult.outputPath && (
                    <button className="primary" onClick={() => revealExport(exportResult.outputPath as string)}>
                      Mostrar en carpeta
                    </button>
                  )}
                  <button onClick={() => dismissExportResult()}>Cerrar</button>
                </div>
              </>
            ) : (
              <>
                <div className="export-fail">✗</div>
                <h2>La exportación falló</h2>
                <p className="export-err">{exportResult.error}</p>
                <div className="export-actions">
                  <button onClick={() => dismissExportResult()}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {syncBusy && (
        <div className="modal-backdrop">
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="spinner" />
            <h2>Analizando audio para sincronizar…</h2>
            <p className="export-note">Comparando las pistas de audio de ambos ángulos. Puede tardar unos segundos.</p>
          </div>
        </div>
      )}

      {transcriptOpen && (
        <div className="modal-backdrop" onMouseDown={() => setTranscriptOpen(false)}>
          <div className="modal transcript-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Transcript</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {transcript && (
                  <button className="primary" onClick={() => void exportTranscriptSrt()} title="Exportar como .srt">
                    ↓ .srt
                  </button>
                )}
                <button
                  onClick={() => { clearTranscript(); setTranscriptOpen(false) }}
                  title="Borrar transcript"
                  style={{ color: 'var(--danger, #e05555)' }}
                >
                  Borrar
                </button>
                <button className="modal-close" onClick={() => setTranscriptOpen(false)}>✕</button>
              </div>
            </div>
            {transcribing ? (
              <div style={{ textAlign: 'center', padding: '2rem' }}>
                <div className="spinner" />
                <p>Transcribiendo con ElevenLabs Scribe…</p>
              </div>
            ) : transcript ? (
              <div className="transcript-body">
                <div className="transcript-plain">
                  {transcript.filter((w) => w.type === 'word').map((w) => w.text).join(' ')}
                </div>
                <div className="transcript-words">
                  {transcript
                    .filter((w) => w.type === 'word')
                    .map((w, i) => (
                      <span key={i} className="transcript-word" title={`${(w.startMs / 1000).toFixed(2)}s – ${(w.endMs / 1000).toFixed(2)}s`}>
                        {w.text}
                        <span className="transcript-ts">{(w.startMs / 1000).toFixed(1)}s</span>
                      </span>
                    ))}
                </div>
              </div>
            ) : (
              <div style={{ padding: '1.5rem', color: 'var(--fg-muted)' }}>
                <p>No hay transcript. Selecciona un clip de video y haz clic en "Transcribir".</p>
                <p style={{ marginTop: 8, fontSize: '0.85em' }}>Requiere <code>ELEVENLABS_API_KEY</code> en .env</p>
              </div>
            )}
          </div>
        </div>
      )}

      {syncResult && (
        <div className="modal-backdrop" onMouseDown={() => dismissSyncResult()}>
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            {syncResult.ok ? (
              <>
                <h2>Sincronización detectada</h2>
                <p className="sync-angles">
                  <strong>Frontal:</strong> {clipDisplayName(syncFrontalId)} · <strong>Lateral:</strong>{' '}
                  {clipDisplayName(syncLateralId)}{' '}
                  <button className="ci-link" onClick={() => setSyncSwap((v) => !v)} title="Intercambiar frontal/lateral">
                    ⇄ Intercambiar
                  </button>
                </p>
                <p className="export-pct">Desfase: {syncResult.offsetSeconds?.toFixed(3)} s</p>
                <p className={`sync-conf ${syncResult.reliable ? 'ok' : 'low'}`}>
                  Confianza: {Math.round((syncResult.confidence ?? 0) * 100)}%
                </p>
                {!syncResult.reliable && (
                  <p className="export-note">
                    ⚠️ Confianza baja: revisa la alineación tras aplicar; quizá debas ajustar manualmente arrastrando un
                    clip.
                  </p>
                )}
                <label className="sync-keep">
                  Mantener audio de:
                  <select value={syncKeepAudio} onChange={(e) => setSyncKeepAudio(e.target.value as 'frontal' | 'lateral')}>
                    <option value="frontal">Frontal</option>
                    <option value="lateral">Lateral</option>
                  </select>
                </label>
                <label className="sync-keep">
                  <input type="checkbox" checked={syncAutoColor} onChange={(e) => setSyncAutoColor(e.target.checked)} />
                  Aplicar colorización por ángulo (Frontal / Lateral)
                </label>
                <div className="export-actions">
                  <button
                    className="primary"
                    onClick={() => {
                      if (syncFrontalId && syncLateralId && syncResult.offsetSeconds !== undefined) {
                        void applySyncAngles({
                          frontalClipId: syncFrontalId,
                          lateralClipId: syncLateralId,
                          offsetSeconds: syncSwap ? -syncResult.offsetSeconds : syncResult.offsetSeconds,
                          keepAudioOf: syncKeepAudio,
                          autoColor: syncAutoColor
                        })
                      }
                      dismissSyncResult()
                    }}
                  >
                    Aplicar
                  </button>
                  <button onClick={() => dismissSyncResult()}>Cancelar</button>
                </div>
              </>
            ) : (
              <>
                <div className="export-fail">✗</div>
                <h2>No se pudo analizar</h2>
                <p className="export-err">{syncResult.error}</p>
                <div className="export-actions">
                  <button onClick={() => dismissSyncResult()}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
