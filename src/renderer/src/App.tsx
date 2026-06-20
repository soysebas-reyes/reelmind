// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect } from 'react'
import { type ClipType, type MediaManifestEntry } from '@core'
import { useEditorStore } from './store'

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
    <div className="asset" title={entry.name}>
      <div className="asset-thumb">
        {thumbnail ? (
          <img src={thumbnail} alt={entry.name} />
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
    init,
    newProject,
    importFiles,
    saveProject,
    openProject,
    setResolution,
    setFps
  } = useEditorStore()

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
          <button onClick={newProject}>New</button>
          <button onClick={() => void openProject()}>Open</button>
          <button className="primary" onClick={() => void saveProject()} disabled={!dirty && !!projectDir}>
            Save
          </button>
        </div>
      </header>

      <main className="bin">
        <div className="bin-head">
          <h2>Media bin</h2>
          <button className="primary" onClick={() => void importFiles()} disabled={!!busy}>
            + Import media
          </button>
        </div>

        {manifest.entries.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No media yet</p>
            <p className="empty-sub">Import video, audio, or images to build your library.</p>
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
      </main>

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
    </div>
  )
}
