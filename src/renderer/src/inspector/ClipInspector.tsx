// SPDX-License-Identifier: GPL-3.0-or-later
// Clip properties inspector — the "Propiedades" tab of the right column (CapCut-style panel, not a
// modal). Values read live from the store's timeline mirror; every write goes through
// EditorController commands. Slider gestures pass a fresh coalesceKey on pointer-down so the whole
// drag collapses into ONE undo step (see EditorController.run).

import { useRef } from 'react'
import { type Clip, clipEndFrame, makeTransform } from '@core'
import { getController, useEditorStore } from '../store'
import Icon from '../ui/Icon'

const SPEED_PRESETS = [0.5, 1, 1.5, 2]

function timecodeish(frames: number, fps: number): string {
  const s = frames / fps
  return `${s.toFixed(2)}s`
}

export default function ClipInspector(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const manifest = useEditorStore((s) => s.manifest)
  const setColorOpen = useEditorStore((s) => s.setColorInspectorOpen)
  const setAudioOpen = useEditorStore((s) => s.setAudioInspectorOpen)

  // One key per slider gesture → one undo step per drag.
  const gestureKeyRef = useRef<string>('')
  const newGesture = (): void => {
    gestureKeyRef.current = crypto.randomUUID()
  }

  const clipId = selectedClipIds.length === 1 ? selectedClipIds[0] : null
  let clip: Clip | null = null
  for (const t of timeline.tracks) {
    const found = t.clips.find((cl) => cl.id === clipId)
    if (found) {
      clip = found
      break
    }
  }

  if (!clipId || !clip) {
    return (
      <section className="clip-inspector">
        <div className="ci-empty">
          <p className="empty-sub">
            {selectedClipIds.length > 1
              ? 'Selecciona un solo clip para editar sus propiedades.'
              : 'Selecciona un clip en la línea de tiempo (o haz doble clic sobre uno).'}
          </p>
        </div>
      </section>
    )
  }

  const c = getController()
  const fps = timeline.fps
  const assetName = manifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? clip.mediaRef
  const isVisual = clip.mediaType !== 'audio'
  const hasAudio = clip.mediaType === 'audio' || clip.mediaType === 'video'
  const t = clip.transform
  const scale = (t.width + t.height) / 2

  const setProps = (props: Parameters<typeof c.setClipProperties>[1], label: string): void =>
    c.setClipProperties(clipId, props, label, gestureKeyRef.current)
  const setTransform = (patch: Partial<typeof t>, label = 'Transformar'): void =>
    setProps({ transform: makeTransform({ ...t, ...patch }) }, label)

  return (
    <section className="clip-inspector">
      <div className="insp-head">
        <span className="insp-name" title={assetName}>
          {clip.textContent !== undefined && clip.textContent !== '' ? clip.textContent : assetName}
        </span>
        <span className="insp-meta">
          {clip.mediaType} · {timecodeish(clip.durationFrames, fps)} · [{clip.startFrame}–{clipEndFrame(clip)}]
        </span>
      </div>

      {isVisual && (
        <div className="insp-section">
          <div className="insp-section-head">
            <h3>Transformación</h3>
            <button className="insp-reset" title="Restablecer" onClick={() => setProps({ transform: makeTransform() }, 'Restablecer transformación')}>
              <Icon name="sync" size={12} />
            </button>
          </div>
          <label className="insp-row">
            <span>Posición X</span>
            <input
              type="range" min={-0.5} max={1.5} step={0.01} value={t.centerX}
              onPointerDown={newGesture}
              onChange={(e) => setTransform({ centerX: Number(e.target.value) })}
            />
            <span className="insp-val">{t.centerX.toFixed(2)}</span>
          </label>
          <label className="insp-row">
            <span>Posición Y</span>
            <input
              type="range" min={-0.5} max={1.5} step={0.01} value={t.centerY}
              onPointerDown={newGesture}
              onChange={(e) => setTransform({ centerY: Number(e.target.value) })}
            />
            <span className="insp-val">{t.centerY.toFixed(2)}</span>
          </label>
          <label className="insp-row">
            <span>Escala</span>
            <input
              type="range" min={0.1} max={3} step={0.01} value={scale}
              onPointerDown={newGesture}
              onChange={(e) => {
                const v = Number(e.target.value)
                const ratio = t.width === 0 ? 1 : t.height / t.width
                setTransform({ width: v, height: v * ratio }, 'Escalar')
              }}
            />
            <span className="insp-val">{Math.round(scale * 100)}%</span>
          </label>
          <label className="insp-row">
            <span>Rotación</span>
            <input
              type="range" min={-180} max={180} step={1} value={t.rotation}
              onPointerDown={newGesture}
              onChange={(e) => setTransform({ rotation: Number(e.target.value) }, 'Rotar')}
            />
            <span className="insp-val">{Math.round(t.rotation)}°</span>
          </label>
          <div className="insp-row insp-buttons">
            <button className={t.flipHorizontal ? 'active' : ''} onClick={() => setTransform({ flipHorizontal: !t.flipHorizontal }, 'Voltear')}>
              ⇋ Horizontal
            </button>
            <button className={t.flipVertical ? 'active' : ''} onClick={() => setTransform({ flipVertical: !t.flipVertical }, 'Voltear')}>
              ⥮ Vertical
            </button>
          </div>
        </div>
      )}

      {isVisual && (
        <div className="insp-section">
          <div className="insp-section-head">
            <h3>Opacidad</h3>
            <button className="insp-reset" title="Restablecer" onClick={() => setProps({ opacity: 1 }, 'Opacidad')}>
              <Icon name="sync" size={12} />
            </button>
          </div>
          <label className="insp-row">
            <span>Opacidad</span>
            <input
              type="range" min={0} max={1} step={0.01} value={clip.opacity}
              onPointerDown={newGesture}
              onChange={(e) => setProps({ opacity: Number(e.target.value) }, 'Opacidad')}
            />
            <span className="insp-val">{Math.round(clip.opacity * 100)}%</span>
          </label>
        </div>
      )}

      <div className="insp-section">
        <div className="insp-section-head">
          <h3>Velocidad</h3>
        </div>
        <div className="insp-row insp-buttons">
          {SPEED_PRESETS.map((v) => (
            <button key={v} className={clip.speed === v ? 'active' : ''} onClick={() => c.setClipSpeed(clipId, v)}>
              {v}×
            </button>
          ))}
        </div>
        <p className="insp-hint">Cambiar la velocidad desplaza los clips contiguos que siguen.</p>
      </div>

      <div className="insp-section">
        <div className="insp-section-head">
          <h3>Fundidos</h3>
          <button
            className="insp-reset" title="Restablecer"
            onClick={() => setProps({ fadeInFrames: 0, fadeOutFrames: 0 }, 'Fundidos')}
          >
            <Icon name="sync" size={12} />
          </button>
        </div>
        <label className="insp-row">
          <span>Entrada</span>
          <input
            type="range" min={0} max={Math.min(10, clip.durationFrames / fps)} step={0.1}
            value={clip.fadeInFrames / fps}
            onPointerDown={newGesture}
            onChange={(e) => setProps({ fadeInFrames: Math.round(Number(e.target.value) * fps) }, 'Fundido de entrada')}
          />
          <span className="insp-val">{(clip.fadeInFrames / fps).toFixed(1)}s</span>
        </label>
        <label className="insp-row">
          <span>Salida</span>
          <input
            type="range" min={0} max={Math.min(10, clip.durationFrames / fps)} step={0.1}
            value={clip.fadeOutFrames / fps}
            onPointerDown={newGesture}
            onChange={(e) => setProps({ fadeOutFrames: Math.round(Number(e.target.value) * fps) }, 'Fundido de salida')}
          />
          <span className="insp-val">{(clip.fadeOutFrames / fps).toFixed(1)}s</span>
        </label>
        <div className="insp-row insp-buttons">
          <button
            className={clip.fadeInInterpolation === 'linear' && clip.fadeOutInterpolation === 'linear' ? 'active' : ''}
            onClick={() => setProps({ fadeInInterpolation: 'linear', fadeOutInterpolation: 'linear' }, 'Interpolación')}
          >
            Lineal
          </button>
          <button
            className={clip.fadeInInterpolation === 'smooth' && clip.fadeOutInterpolation === 'smooth' ? 'active' : ''}
            onClick={() => setProps({ fadeInInterpolation: 'smooth', fadeOutInterpolation: 'smooth' }, 'Interpolación')}
          >
            Suave
          </button>
        </div>
      </div>

      {hasAudio && (
        <div className="insp-section">
          <div className="insp-section-head">
            <h3>Volumen</h3>
            <button className="insp-reset" title="Restablecer" onClick={() => setProps({ volume: 1 }, 'Volumen')}>
              <Icon name="sync" size={12} />
            </button>
          </div>
          <label className="insp-row">
            <span>Volumen</span>
            <input
              type="range" min={0} max={2} step={0.01} value={clip.volume}
              onPointerDown={newGesture}
              onChange={(e) => setProps({ volume: Number(e.target.value) }, 'Volumen')}
            />
            <span className="insp-val">{Math.round(clip.volume * 100)}%</span>
          </label>
        </div>
      )}

      <div className="insp-section insp-links">
        {isVisual && (
          <button className="insp-link" onClick={() => setColorOpen(true)}>
            <Icon name="wand" size={14} /> Colorizar…
          </button>
        )}
        {hasAudio && (
          <button className="insp-link" onClick={() => setAudioOpen(true)}>
            <Icon name="waveform" size={14} /> Realzar audio…
          </button>
        )}
      </div>
    </section>
  )
}
