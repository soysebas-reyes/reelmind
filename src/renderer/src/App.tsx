// SPDX-License-Identifier: GPL-3.0-or-later
import { type CSSProperties, useEffect, useState } from 'react'
import { type ClipType, type MediaManifestEntry } from '@core'
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
    setFps
  } = useEditorStore()

  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [colorOpen, setColorOpen] = useState(false)
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">ReelMind</span>
          <span className="proj">
            {projectName}
            {dirty && <span className="dot" title="Unsaved changes" />}
          </span>
        </div>

        <div className="settings">
          <label>
            Resolution
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
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="actions">
          <button onClick={() => getController().undo()} disabled={!canUndo} title={undoLabel ? `Undo ${undoLabel}` : 'Undo'}>
            ↶ Undo
          </button>
          <button onClick={() => getController().redo()} disabled={!canRedo} title={redoLabel ? `Redo ${redoLabel}` : 'Redo'}>
            ↷ Redo
          </button>
          <span className="tl-sep" />
          <button onClick={newProject}>New</button>
          <button onClick={() => void openProject()}>Open</button>
          <button className="primary" onClick={() => void saveProject()} disabled={!dirty && !!projectDir}>
            Save
          </button>
          <button onClick={() => void exportProject()} disabled={!!busy || timeline.tracks.length === 0}>
            Export
          </button>
          <button
            onClick={() => setColorOpen(true)}
            disabled={selectedClipIds.length === 0}
            title={selectedClipIds.length === 0 ? 'Selecciona un clip para colorizar' : 'Colorización'}
          >
            🎨 Color
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
            <ColorInspector />
          </div>
        </div>
      )}
    </div>
  )
}
