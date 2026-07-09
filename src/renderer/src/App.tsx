// SPDX-License-Identifier: GPL-3.0-or-later
import { type CSSProperties, type DragEvent, useEffect, useState } from 'react'
import { type ClipType, type MediaManifestEntry, type TrackRole } from '@core'
import type { ExportQuality } from '../../shared/ipc'
import { getController, useEditorStore } from './store'
import Timeline from './timeline/Timeline'
import Preview from './preview/Preview'
import ChatPanel from './ai/ChatPanel'
import ColorInspector from './color/ColorInspector'
import AudioInspector from './audio/AudioInspector'
import ClipInspector from './inspector/ClipInspector'
import { TakesPlanModal } from './takes/TakesPlanModal'
import { SessionTabs } from './tabs/SessionTabs'
import { Icon, type IconName } from './ui/Icon'
import { Reelo, REELO_MESSAGES } from './ui/Reelo'

const RESOLUTIONS: { label: string; w: number; h: number }[] = [
  { label: '1920×1080 (16:9)', w: 1920, h: 1080 },
  { label: '1080×1920 (9:16)', w: 1080, h: 1920 },
  { label: '1280×720 (16:9)', w: 1280, h: 720 },
  { label: '3840×2160 (4K)', w: 3840, h: 2160 },
  { label: '1080×1080 (1:1)', w: 1080, h: 1080 }
]
const FPS_OPTIONS = [24, 25, 30, 50, 60]
// 'high'/'veryHigh' render on the GPU when hay una usable (export mucho más rápido); 'max' siempre CPU.
const QUALITY_OPTIONS: { value: ExportQuality; label: string }[] = [
  { value: 'high', label: 'Alta (la más rápida)' },
  { value: 'veryHigh', label: 'Muy alta (recomendada)' },
  { value: 'max', label: 'Máxima (lenta, sin pérdida visual)' }
]

const TYPE_ICON: Record<ClipType, IconName> = {
  video: 'video',
  audio: 'music',
  image: 'image',
  text: 'text',
  lottie: 'sparkles'
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
          <span className="asset-thumb-glyph">
            <Icon name={TYPE_ICON[entry.type]} size={30} />
          </span>
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
        {entry.type === 'video' && <Icon name={entry.hasAudio ? 'sound' : 'mute'} size={13} />}
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
    exportBatch,
    exportResult,
    proxying,
    tabs,
    dismissExportResult,
    revealExport,
    exportToNle,
    handoffProgress,
    handoffResult,
    dismissHandoffResult,
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
  // Store-owned so the clip context menu (Timeline) can open these too.
  const colorOpen = useEditorStore((s) => s.colorInspectorOpen)
  const setColorOpen = useEditorStore((s) => s.setColorInspectorOpen)
  const audioOpen = useEditorStore((s) => s.audioInspectorOpen)
  const setAudioOpen = useEditorStore((s) => s.setAudioInspectorOpen)
  const rightTab = useEditorStore((s) => s.rightTab)
  const setRightTab = useEditorStore((s) => s.setRightTab)
  const analyzingTakes = useEditorStore((s) => s.analyzingTakes)
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  // Sync confirmation modal options (frontal/lateral swap, which audio to keep, per-angle color).
  const [syncSwap, setSyncSwap] = useState(false)
  const [syncKeepAudio, setSyncKeepAudio] = useState<'frontal' | 'lateral'>('frontal')
  const [syncAutoColor, setSyncAutoColor] = useState(true)
  const [nleMenuOpen, setNleMenuOpen] = useState(false)
  // Multi-tab export picker ("¿cuál pestaña exportar, o todas?").
  const [exportPickerOpen, setExportPickerOpen] = useState(false)
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

  // OS Explorer → media bin drop (works alongside the Importar button; folders expand in main).
  const binDragOver = (e: DragEvent): void => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const binDrop = (e: DragEvent): void => {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.editorBridge.getPathForFile(f))
      .filter((p): p is string => !!p)
    if (paths.length > 0) void useEditorStore.getState().importFromSources(paths)
  }

  // Multicam actions key off how many *video* clips are selected.
  const selectedVideoIds = selectedClipIds.filter((id) => getController().getClip(id)?.mediaType === 'video')
  const canExtractAudio = selectedVideoIds.length === 1
  const canSyncAngles = selectedVideoIds.length === 2
  // Manual razor ("Cortar tomas") splits all tracks at the playhead — enabled whenever the timeline has
  // any video clip (no selection needed; it only cuts where the playhead is inside a clip).
  const canRazor = timeline.tracks.some((t) => t.type === 'video' && t.clips.length > 0)
  // Angle changes need 2-3 DISTINCT video tracks selected (frontal + lateral + optional b-roll).
  const selectedVideoTrackIds = new Set(
    selectedVideoIds.map((id) => getController().getTrackOfClip(id)?.id).filter((x): x is string => !!x)
  )
  const canChangeAngles = selectedVideoTrackIds.size >= 2 && selectedVideoTrackIds.size <= 3
  const canTranscribe = selectedVideoIds.length >= 1
  // Enhance audio works ONLY on a single selected clip that lives on an audio track.
  const enhanceClipId = selectedClipIds.length === 1 ? selectedClipIds[0] : null
  const enhanceMediaType = enhanceClipId ? getController().getClip(enhanceClipId)?.mediaType : undefined
  const canEnhanceAudio = enhanceMediaType === 'audio'
  const videosNeedingProxy = manifest.entries.filter((e) => e.type === 'video' && !e.proxyPath).length
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
            <div className="topbar-actions" style={{ marginLeft: '1rem', display: 'flex', gap: '0.5rem' }}>
              <button onClick={() => newProject()} disabled={!!busy} title="Nuevo Proyecto">
                <Icon name="plus" /> Nuevo
              </button>
              <button onClick={() => void openProject()} disabled={!!busy} title="Abrir Proyecto">
                <Icon name="folder" /> Abrir
              </button>
              <button onClick={() => void saveProject()} disabled={!!busy} title="Guardar Proyecto">
                <Icon name="save" /> Guardar
              </button>
              <button
                className="primary"
                onClick={() => (tabs.length > 1 ? setExportPickerOpen(true) : void exportProject())}
                disabled={!!busy}
                title={tabs.length > 1 ? 'Exportar: elegí qué pestañas (o todas)' : 'Exportar Video'}
              >
                <Icon name="export" /> Exportar{tabs.length > 1 ? '…' : ''}
              </button>
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => setNleMenuOpen((o) => !o)}
                  disabled={!!busy}
                  title="Enviar a Premiere / DaVinci / Final Cut (proyecto editable + media con color y audio ya aplicados)"
                >
                  <Icon name="export" /> Enviar a editor ▾
                </button>
                {nleMenuOpen && (
                  <>
                    <div className="menu-scrim" onMouseDown={() => setNleMenuOpen(false)} />
                    <div className="nle-menu">
                      {(
                        [
                          ['premiere', 'Premiere Pro'],
                          ['resolve', 'DaVinci Resolve'],
                          ['finalcut', 'Final Cut Pro']
                        ] as const
                      ).map(([target, label]) => (
                        <button
                          key={target}
                          onClick={() => {
                            setNleMenuOpen(false)
                            void exportToNle(target)
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Row 2: action toolbar in the real workflow order — sync → audio → color → guiones → ángulos
            → cortes manuales. Secondary/destructive actions live on the track headers + context menus. */}
        <div className="toolbar">
          <button
            onClick={() => { setSyncSwap(false); setSyncKeepAudio('frontal'); setSyncAutoColor(true); void analyzeSyncForSelection() }}
            disabled={!canSyncAngles || !!busy || syncBusy}
            title={canSyncAngles ? 'Sincroniza y recorta 2 ángulos por audio' : 'Selecciona exactamente 2 clips de video (frontal y lateral)'}
          >
            <Icon name="sync" /> 1. Sincronizar
          </button>

          <button
            onClick={() => setAudioOpen(true)}
            disabled={!canEnhanceAudio || !!busy}
            title={
              canEnhanceAudio
                ? 'Abrir el explorador de realce de audio (preview A/B + ajustes)'
                : 'Selecciona el clip de la pista de audio (la que creó Sincronizar)'
            }
          >
            <Icon name="waveform" /> 2. Realzar audio
          </button>

          <button
            onClick={() => setColorOpen(true)}
            disabled={selectedClipIds.length === 0}
            title={selectedClipIds.length === 0 ? 'Selecciona un clip de video para colorizar' : 'Abrir explorador de colorización'}
          >
            <Icon name="wand" /> 3. Colorizar
          </button>

          <button
            onClick={() => useEditorStore.getState().setTakesInputOpen(true)}
            disabled={
              analyzingTakes ||
              !!busy ||
              syncBusy ||
              !timeline.tracks.some((t) => t.clips.some((c) => c.mediaType === 'video' || c.mediaType === 'audio'))
            }
            title="Segmentar el crudo por guiones con IA: pegá tus guiones y se abre una pestaña por guión, ya recortada"
          >
            <Icon name="wand" /> {analyzingTakes ? 'Segmentando…' : '4. Guiones (IA)'}
          </button>

          <button
            onClick={() => void useEditorStore.getState().analyzeAutoAngles()}
            disabled={!canChangeAngles || !!busy}
            title={
              canChangeAngles
                ? 'Analizar el volumen y previsualizar los cambios de ángulo. Antes, verificá los chips F/L en las cabeceras de pista (clic para cambiar el rol).'
                : 'Haz clic en el nombre de cada pista de video (frontal, lateral y opcional b-roll) para seleccionarla completa'
            }
          >
            <Icon name="angles" /> 5. Ángulos
          </button>

          <button
            onClick={() => getController().razorAtPlayhead()}
            disabled={!canRazor || !!busy || syncBusy}
            title={
              canRazor
                ? 'Cortar (split) en el cursor: todas las pistas a la vez. Para un tartamudeo/repetición: cortá al inicio y al final, seleccioná el tramo y borralo.'
                : 'Agrega clips de video a la línea de tiempo'
            }
          >
            <Icon name="cut" /> 6. Cortar
          </button>

          <span className="spacer" style={{ flex: 1 }} />

          {/* Proxies now start automatically on import; this chip shows the background progress.
              The button only appears for footage that still lacks a proxy (e.g. an old project). */}
          {proxying ? (
            <span
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.85em', color: 'var(--fg-muted, #8e8e93)' }}
              title="Generando proxies de reproducción en segundo plano — podés seguir editando"
            >
              <Reelo state="loading" size={20} ariaLabel="Generando proxies" />
              Optimizando reproducción… {proxying.done}/{proxying.total}
            </span>
          ) : videosNeedingProxy > 0 ? (
            <button
              onClick={() => void useEditorStore.getState().optimizePlayback()}
              disabled={!!busy}
              title={`Genera proxies para ${videosNeedingProxy} video(s) → reproducción fluida (el export usa el original)`}
            >
              <Icon name="bolt" /> Optimizar reproducción ({videosNeedingProxy})
            </button>
          ) : null}
        </div>
      </header>

      <SessionTabs />

      <div className="workspace" style={{ '--timeline-h': `${layout.timelineH}px` } as CSSProperties}>
        <div className="stage" style={{ '--bin-w': `${layout.binW}px`, '--chat-w': `${layout.chatW}px` } as CSSProperties}>
          <section className="bin" onDragOver={binDragOver} onDrop={binDrop}>
            <div className="bin-head">
              <h2>Medios</h2>
              <button className="primary" onClick={() => void importFiles()} disabled={!!busy}>
                <Icon name="plus" size={15} /> Importar
              </button>
            </div>

            {manifest.entries.length === 0 ? (
              <div className="empty">
                <p className="empty-title">Aún no hay medios</p>
                <p className="empty-sub">Importa video, audio o imágenes y arrástralos a la línea de tiempo.</p>
                <button className="primary" onClick={() => void importFiles()}>
                  <Icon name="plus" size={15} /> Importar medios
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
          <div className="right-panel">
            <div className="right-tabs">
              <button className={rightTab === 'chat' ? 'active' : ''} onClick={() => setRightTab('chat')}>
                Chat IA
              </button>
              <button className={rightTab === 'props' ? 'active' : ''} onClick={() => setRightTab('props')}>
                Propiedades
              </button>
            </div>
            {/* ChatPanel stays mounted (hidden) so the conversation survives tab switches. */}
            <div className="right-slot" style={{ display: rightTab === 'chat' ? 'flex' : 'none' }}>
              <ChatPanel />
            </div>
            {rightTab === 'props' && <ClipInspector />}
          </div>
        </div>

        <ResizeHandle axis="y" onResize={(d) => setLayout((l) => ({ ...l, timelineH: clampPx(l.timelineH - d, 140, 760) }))} />
        <Timeline />
      </div>

      <footer className="statusbar">
        <span className={`pill ${ffmpegOk ? 'ok' : 'warn'}`}>
          {ffmpegOk ? `FFmpeg ready` : 'FFmpeg not found — install it and restart'}
        </span>
        {busy && (
          <span className="busy" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Reelo state="loading" size={22} ariaLabel="Trabajando" />
            {busy}
          </span>
        )}
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
                <Icon name="close" size={15} />
              </button>
            </div>
            <ColorInspector onClose={() => setColorOpen(false)} />
          </div>
        </div>
      )}

      {audioOpen && (
        <div className="modal-backdrop" onMouseDown={() => setAudioOpen(false)}>
          <div className="modal color-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h2>Realzar audio</h2>
              <button className="modal-close" onClick={() => setAudioOpen(false)} title="Cerrar">
                <Icon name="close" size={15} />
              </button>
            </div>
            <AudioInspector onClose={() => setAudioOpen(false)} />
          </div>
        </div>
      )}

      {/* Blocking export overlay: a long render must finish before the .mp4 is playable, so we show
          real progress and explicitly tell the user not to open the file / close the app until done. */}
      {exportProgress !== null && (
        <div className="modal-backdrop">
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            <Reelo state={exportProgress >= 1 ? 'success' : 'progress'} size={72} progress={exportProgress} ariaLabel="Reelo exportando" />
            <h2>
              {exportProgress >= 1
                ? '¡Y… corten!'
                : exportBatch
                  ? `Exportando ${exportBatch.index + 1}/${exportBatch.total}: ${exportBatch.name}`
                  : 'Exportando tu video…'}
            </h2>
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

      <ProgressModal />
      <AnglePlanModal />
      <TakesPlanModal />

      {exportResult && (
        <div className="modal-backdrop" onMouseDown={() => dismissExportResult()}>
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            {exportResult.ok ? (
              <>
                <div className="export-check">✓</div>
                <h2>{exportResult.batch ? `Exportación completa (${exportResult.batch.length} videos)` : 'Exportación completa'}</h2>
                <p className="export-path" title={exportResult.outputPath}>
                  {exportResult.outputPath}
                </p>
              </>
            ) : (
              <>
                <div className="export-fail">✗</div>
                <h2>{exportResult.batch ? 'Exportación con errores' : 'La exportación falló'}</h2>
                {!exportResult.batch && <p className="export-err">{exportResult.error}</p>}
              </>
            )}
            {exportResult.batch && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0', textAlign: 'left', maxHeight: '30vh', overflowY: 'auto' }}>
                {exportResult.batch.map((b, i) => (
                  <li key={i} style={{ padding: '2px 0', color: b.ok ? undefined : 'var(--danger, #e05555)' }}>
                    {b.ok ? '✓' : '✗'} {b.name}
                    {!b.ok && b.error ? ` — ${b.error.split('\n')[0]}` : ''}
                  </li>
                ))}
              </ul>
            )}
            <div className="export-actions">
              {exportResult.outputPath && (exportResult.ok || exportResult.batch) && (
                <button className="primary" onClick={() => revealExport(exportResult.outputPath as string)}>
                  Mostrar en carpeta
                </button>
              )}
              <button onClick={() => dismissExportResult()}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {exportPickerOpen && <ExportPickerModal onClose={() => setExportPickerOpen(false)} />}

      {/* NLE handoff: baking media (color + audio) then writing the editable XML. */}
      {handoffProgress !== null && (
        <div className="modal-backdrop">
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            <Reelo state={handoffProgress >= 1 ? 'success' : 'progress'} size={72} progress={handoffProgress} ariaLabel="Reelo preparando handoff" />
            <h2>{handoffProgress >= 1 ? '¡Listo para tu editor!' : 'Preparando para tu editor…'}</h2>
            <div className="export-bar">
              <div className="export-bar-fill" style={{ width: `${Math.round(handoffProgress * 100)}%` }} />
            </div>
            <p className="export-pct">{Math.round(handoffProgress * 100)}%</p>
            <p className="export-note">
              Aplicando tu color y realce de audio a la media y armando el proyecto editable. No cierres la app.
            </p>
          </div>
        </div>
      )}

      {handoffResult && (
        <div className="modal-backdrop" onMouseDown={() => dismissHandoffResult()}>
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            {handoffResult.ok ? (
              <>
                <div className="export-check">✓</div>
                <h2>Proyecto listo para tu editor</h2>
                <p className="export-path" title={handoffResult.folder}>
                  {handoffResult.folder}
                </p>
                <p className="export-note">
                  {handoffResult.clipItemCount ?? 0} clips · {handoffResult.bakedCount ?? 0} horneados ·{' '}
                  {handoffResult.referencedCount ?? 0} referenciados. Importá el .xml desde tu editor (ver README).
                </p>
                {handoffResult.warnings && handoffResult.warnings.length > 0 && (
                  <ul className="handoff-warnings">
                    {handoffResult.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="export-actions">
                  {handoffResult.xmlPath && (
                    <button className="primary" onClick={() => revealExport(handoffResult.xmlPath as string)}>
                      Mostrar en carpeta
                    </button>
                  )}
                  <button onClick={() => dismissHandoffResult()}>Cerrar</button>
                </div>
              </>
            ) : (
              <>
                <div className="export-fail">✗</div>
                <h2>El handoff falló</h2>
                <p className="export-err">{handoffResult.error}</p>
                <div className="export-actions">
                  <button onClick={() => dismissHandoffResult()}>Cerrar</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {syncBusy && (
        <div className="modal-backdrop">
          <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
            <Reelo state="loading" size={72} ariaLabel="Reelo sincronizando" />
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
                    <Icon name="download" size={14} /> .srt
                  </button>
                )}
                <button
                  onClick={() => { clearTranscript(); setTranscriptOpen(false) }}
                  title="Borrar transcript"
                  style={{ color: 'var(--danger, #e05555)' }}
                >
                  Borrar
                </button>
                <button className="modal-close" onClick={() => setTranscriptOpen(false)}>
                  <Icon name="close" size={15} />
                </button>
              </div>
            </div>
            {transcribing ? (
              <div style={{ textAlign: 'center', padding: '2rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <Reelo state="loading" size={56} ariaLabel="Reelo transcribiendo" />
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
                    <Icon name="swap" size={13} /> Intercambiar
                  </button>
                </p>
                <p className="export-pct">Desfase: {syncResult.offsetSeconds?.toFixed(3)} s</p>
                <p className={`sync-conf ${syncResult.reliable ? 'ok' : 'low'}`}>
                  Método: {syncResult.method === 'transcript' ? 'transcript (palabras)' : 'audio (correlación)'} · Confianza:{' '}
                  {Math.round((syncResult.confidence ?? 0) * 100)}%
                </p>
                {syncResult.transcriptRefuted && (
                  <p className="export-note">
                    ℹ️ El transcript sugería otro desfase y fue descartado: la correlación de audio fue más confiable en
                    este material (típico con guiones repetidos en varias tomas).
                  </p>
                )}
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

/** Multi-tab export picker: choose which tabs to render (default: all). One tab → save dialog;
 *  several → one folder, a <tab>.mp4 per selection, sequential with combined progress. */
function ExportPickerModal({ onClose }: { onClose: () => void }) {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const exportTabs = useEditorStore((s) => s.exportTabs)
  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(tabs.map((t) => [t.id, true]))
  )
  const selectedIds = tabs.filter((t) => checked[t.id]).map((t) => t.id)
  const allChecked = selectedIds.length === tabs.length
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal export-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>¿Qué querés exportar?</h2>
        <p className="export-note">
          Cada pestaña se exporta como su propio .mp4. Una sola → elegís el archivo; varias → elegís una
          carpeta y se renderizan una por una.
        </p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 2px', borderBottom: '1px solid var(--border, #3a3a3c)', marginBottom: 4 }}>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => setChecked(Object.fromEntries(tabs.map((t) => [t.id, e.target.checked])))}
          />
          <strong>Todas las pestañas ({tabs.length})</strong>
        </label>
        <div style={{ maxHeight: '38vh', overflowY: 'auto', textAlign: 'left' }}>
          {tabs.map((t) => (
            <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 2px' }}>
              <input
                type="checkbox"
                checked={!!checked[t.id]}
                onChange={(e) => setChecked((c) => ({ ...c, [t.id]: e.target.checked }))}
              />
              <span>
                {t.name}
                {t.id === activeTabId && <span style={{ color: 'var(--fg-muted, #8e8e93)' }}> (actual)</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="export-actions">
          <button
            className="primary"
            disabled={selectedIds.length === 0}
            onClick={() => {
              onClose()
              void exportTabs(selectedIds)
            }}
          >
            Exportar {selectedIds.length === tabs.length ? 'todas' : `(${selectedIds.length})`}
          </button>
          <button onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}

/** Live backend-progress modal for long ops (auto-angles): step checklist + expandable raw console.
 *  Uses selector hooks so it only re-renders on progress changes, not the whole App. */
function ProgressModal() {
  const progress = useEditorStore((s) => s.progress)
  const dismiss = useEditorStore((s) => s.dismissProgress)
  const [showLog, setShowLog] = useState(false)
  const [msgIdx, setMsgIdx] = useState(0)
  const active = !!progress && !progress.done && !progress.error
  // Rotate a playful cinema line while Reelo works (paused when done or on error).
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setMsgIdx((i) => (i + 1) % REELO_MESSAGES.length), 1600)
    return () => clearInterval(id)
  }, [active])
  if (!progress) return null
  const ico = (status: string): string =>
    status === 'done' ? '✓' : status === 'error' ? '✗' : status === 'active' ? '…' : '○'
  return (
    <div className="modal-backdrop modal-backdrop-front">
      <div className="modal export-modal progress-modal" onMouseDown={(e) => e.stopPropagation()}>
        <Reelo
          state={progress.error ? 'idle' : progress.done ? 'success' : 'progress'}
          size={72}
          progress={0.6}
          ariaLabel="Reelo trabajando"
        />
        <h2>{progress.title}</h2>
        {active && <p className="progress-msg">{REELO_MESSAGES[msgIdx]}</p>}
        <ul className="progress-steps">
          {progress.steps.map((st) => (
            <li key={st.id} className={`progress-step ${st.status}`}>
              <span className="progress-ico">{ico(st.status)}</span>
              <span className="progress-label">{st.label}</span>
              {st.detail && <span className="progress-detail">{st.detail}</span>}
            </li>
          ))}
        </ul>
        {progress.error && <p className="export-err">{progress.error}</p>}
        {progress.log.length > 0 && (
          <button className="ci-link" onClick={() => setShowLog((v) => !v)}>
            {showLog ? 'Ocultar' : 'Ver'} detalle técnico ({progress.log.length})
          </button>
        )}
        {showLog && (
          <pre
            className="progress-console"
            ref={(el) => {
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            {progress.log.join('\n')}
          </pre>
        )}
        <p className="export-note">
          {progress.done ? 'Proceso terminado.' : 'Esto puede tardar varios minutos. No cierres la app.'}
        </p>
        {progress.done && (
          <div className="export-actions">
            <button className="primary" onClick={dismiss}>
              Cerrar
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const ANGLE_ROLE_COLOR: Record<TrackRole, string> = { frontal: '#0a84ff', lateral: '#ff9f0a', broll: '#ff375f' }
const ROLE_LABEL: Record<TrackRole, string> = { frontal: 'Frontal', lateral: 'Lateral', broll: 'B-roll' }
const ROLE_INITIAL: Record<TrackRole, string> = { frontal: 'F', lateral: 'L', broll: 'B' }

function secLabel(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

type PlanCut = { sec: number; role: TrackRole; trigger?: 'pausa' | 'pico' }

/** One angle's volume waveform (RMS envelope + emphasis peaks + pauses) with the plan's cut lines
 *  overlaid, so it's transparent WHERE each angle change was identified on this angle's own audio. */
function AngleWave({
  envelope,
  peaks,
  pauses,
  cuts,
  durationSec,
  role,
  label,
  height = 64
}: {
  envelope: number[]
  peaks: number[]
  pauses?: number[]
  cuts?: PlanCut[]
  durationSec: number
  role: TrackRole
  label: string
  height?: number
}) {
  const W = 1000
  const H = height
  const dur = durationSec > 0 ? durationSec : 1
  const xAt = (sec: number): number => Math.max(0, Math.min(W, (sec / dur) * W))
  const pts = envelope.map(
    (v, i) => `${(envelope.length > 1 ? (i / (envelope.length - 1)) * W : 0).toFixed(1)},${(H - v * H).toFixed(1)}`
  )
  const areaPath = envelope.length ? `M0,${H} L${pts.join(' L')} L${W},${H} Z` : ''
  return (
    <div className="angleplan-graph">
      <span className="angleplan-graph-label" style={{ color: ANGLE_ROLE_COLOR[role] }}>
        {label} · {ROLE_LABEL[role]}
      </span>
      <svg
        className="angleplan-wave"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Volumen ${label}`}
        style={{ height: H }}
      >
        {areaPath ? (
          <path d={areaPath} fill={ANGLE_ROLE_COLOR[role]} opacity={0.4} />
        ) : (
          <text x={8} y={H / 2} fill="#8e8e93" fontSize={11}>
            (sin audio)
          </text>
        )}
        {(pauses ?? []).map((p, i) => (
          <line key={`pa${i}`} x1={xAt(p)} x2={xAt(p)} y1={H - 8} y2={H} stroke="#8e8e93" strokeWidth={1} opacity={0.7} />
        ))}
        {peaks.map((p, i) => (
          <line key={`pk${i}`} x1={xAt(p)} x2={xAt(p)} y1={0} y2={8} stroke="#ff9f0a" strokeWidth={1} opacity={0.9} />
        ))}
        {(cuts ?? []).map((c, i) => (
          <line
            key={`ct${i}`}
            x1={xAt(c.sec)}
            x2={xAt(c.sec)}
            y1={0}
            y2={H}
            stroke={ANGLE_ROLE_COLOR[c.role]}
            strokeWidth={1.25}
            strokeDasharray="4 3"
            opacity={0.95}
          />
        ))}
      </svg>
    </div>
  )
}

/** Preview of the proposed angle-cut plan, built for transparency: editable role mapping, a tall master
 *  intensity curve of the frontal angle with every cut marked (and WHY — pausa/pico), a chip per cut,
 *  per-angle volume graphs with the same cuts overlaid, a destructive/non-destructive toggle, and a
 *  per-segment list. Confirm → apply (the cuts actually run on the video tracks). */
function AnglePlanModal() {
  const plan = useEditorStore((s) => s.anglePlan)
  const apply = useEditorStore((s) => s.applyAnglePlan)
  const dismiss = useEditorStore((s) => s.dismissAnglePlan)
  const setRole = useEditorStore((s) => s.setAnglePlanRole)
  const setDestructive = useEditorStore((s) => s.setAnglePlanDestructive)
  if (!plan) return null

  // Roles available as options = first N of frontal/lateral/broll, where N = number of angles.
  const roleOptions = (['frontal', 'lateral', 'broll'] as TrackRole[]).slice(0, plan.angleTracks.length)
  const cuts: PlanCut[] = plan.segments.slice(1).map((s) => ({ sec: s.startSec, role: s.role, trigger: s.trigger }))
  const picoCount = cuts.filter((c) => c.trigger === 'pico').length
  const pausaCount = cuts.filter((c) => c.trigger === 'pausa').length
  const master = plan.angleTracks[0]
  const rest = plan.angleTracks.slice(1)

  return (
    <div className="modal-backdrop">
      <div className="modal export-modal angleplan-modal" style={{ maxHeight: '92vh' }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Plan de cambios de ángulo</h2>
        <p className="export-note">
          {plan.angleTracks.length} ángulos · <strong>{cuts.length} cortes</strong> ({pausaCount} por pausa ⏸︎,{' '}
          {picoCount} por pico 📈) · modo {plan.destructive ? 'destructivo' : 'no destructivo'}
        </p>

        <div className="angleplan-scroll">
          {/* Editable role mapping: which track is Frontal / Lateral / B-roll. */}
          <div className="angleplan-roles">
            {plan.angleTracks.map((a) => (
              <label key={a.trackId} className="angleplan-role" style={{ borderColor: ANGLE_ROLE_COLOR[a.role] }}>
                <span className="angleplan-role-track">{a.label}</span>
                <select value={a.role} onChange={(e) => setRole(a.trackId, e.target.value as TrackRole)}>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          {/* Master intensity curve (frontal): where each angle change was identified, colored by the
              angle it switches to. Pauses (bottom, gray) and peaks (top, orange) are the cut triggers. */}
          {master && (
            <AngleWave
              envelope={master.envelope}
              peaks={master.peaks}
              pauses={master.pauses}
              cuts={cuts}
              durationSec={plan.durationSec}
              role={master.role}
              label={master.label}
              height={132}
            />
          )}
          <div className="angleplan-legend">
            <span>
              <i style={{ background: '#ff9f0a' }} /> pico (énfasis)
            </span>
            <span>
              <i style={{ background: '#8e8e93' }} /> pausa (silencio)
            </span>
            <span>
              <i className="dash" /> corte de ángulo (color = ángulo destino)
            </span>
          </div>

          {/* One chip per cut: time + trigger + destination angle — the literal change list. */}
          <div className="angleplan-cuts">
            {cuts.length === 0 ? (
              <span className="angleplan-cut-empty">Sin cortes</span>
            ) : (
              cuts.map((c, i) => (
                <span key={i} className="angleplan-cut-chip" style={{ borderColor: ANGLE_ROLE_COLOR[c.role] }}>
                  {secLabel(c.sec)} {c.trigger === 'pico' ? '📈' : '⏸︎'} → {ROLE_LABEL[c.role]}
                </span>
              ))
            )}
          </div>

          {/* Remaining angles' volume graphs (frontal is the master above), with the cuts overlaid. */}
          {rest.length > 0 && (
            <div className="angleplan-graphs">
              {rest.map((a) => (
                <AngleWave
                  key={a.trackId}
                  envelope={a.envelope}
                  peaks={a.peaks}
                  pauses={a.pauses}
                  cuts={cuts}
                  durationSec={plan.durationSec}
                  role={a.role}
                  label={a.label}
                />
              ))}
            </div>
          )}

          <div className="angleplan-list">
            {plan.segments.map((s, i) => (
              <div key={`row${i}`} className="angleplan-row">
                <span className="angleplan-chip" style={{ background: ANGLE_ROLE_COLOR[s.role] }}>
                  {ROLE_INITIAL[s.role]}
                </span>
                <span className="angleplan-time">
                  {secLabel(s.startSec)}–{secLabel(s.endSec)}
                </span>
                <span className="angleplan-trigger">{s.trigger ? (s.trigger === 'pico' ? '📈 pico' : '⏸︎ pausa') : '▶ inicio'}</span>
                <span className="angleplan-text">{s.text.trim() || '—'}</span>
              </div>
            ))}
          </div>
        </div>

        <label className="angleplan-mode">
          <input type="checkbox" checked={plan.destructive} onChange={(e) => setDestructive(e.target.checked)} />
          Modo destructivo (elimina los fragmentos ocultos de cada pista). Si lo desactivás, quedan invisibles
          pero conservados (opacity 0). Reversible con Ctrl+Z.
        </label>
        <div className="export-actions">
          <button className="primary" onClick={() => apply()}>
            Aplicar cortes
          </button>
          <button onClick={() => dismiss()}>Cancelar</button>
        </div>
      </div>
    </div>
  )
}
