// SPDX-License-Identifier: GPL-3.0-or-later
// Phase 9.5 Colorization Explorer — rendered inside a modal. Left: a large EXACT preview (FFmpeg
// still, incl. LUT) of the selected shot + a compare strip of saved muestras vs the RAW, so it's
// always clear which frame the grade is centered on. Right: recommended configs, every parameter,
// and the apply / save / Elegir actions.
//
// The exact preview uses the same color chain as the export (color:still IPC). The main Canvas shows
// a fast approximation (no LUT) for committed grades; this still is the reference look.

import { useEffect, useRef, useState } from 'react'
import {
  type ColorAdjustments,
  DOCUMENT_PRESETS,
  GENERIC_LOOKS,
  clipSourceSecondsAt,
  colorIsIdentity,
  expectedPath,
  makeColorAdjustments,
  mergeColor,
  parseLutRef
} from '@core'
import { getController, useEditorStore } from '../store'

type NumericColorKey = Exclude<keyof ColorAdjustments, 'lutRef'>

interface SliderDef {
  key: NumericColorKey
  label: string
  min: number
  max: number
  step: number
}

const SLIDERS: SliderDef[] = [
  { key: 'exposure', label: 'Exposición', min: -2, max: 2, step: 0.05 },
  { key: 'contrast', label: 'Contraste', min: 0, max: 2, step: 0.01 },
  { key: 'saturation', label: 'Saturación', min: 0, max: 2, step: 0.01 },
  { key: 'temperature', label: 'Temperatura', min: -100, max: 100, step: 1 },
  { key: 'tint', label: 'Tinte', min: -100, max: 100, step: 1 },
  { key: 'hue', label: 'Tono', min: -180, max: 180, step: 1 },
  { key: 'gamma', label: 'Gamma', min: 0.1, max: 3, step: 0.01 },
  { key: 'highlights', label: 'Resaltados', min: -100, max: 100, step: 1 },
  { key: 'shadows', label: 'Sombras', min: -100, max: 100, step: 1 },
  { key: 'whites', label: 'Blancos', min: -100, max: 100, step: 1 },
  { key: 'blacks', label: 'Negros', min: -100, max: 100, step: 1 },
  { key: 'lutIntensity', label: 'Intensidad LUT', min: 0, max: 1, step: 0.01 }
]

interface Sample {
  id: string
  name: string
  color: ColorAdjustments
  url: string | null
}

export default function ColorInspector({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const timeline = useEditorStore((s) => s.timeline)
  const manifest = useEditorStore((s) => s.manifest)
  const projectDir = useEditorStore((s) => s.projectDir)
  const currentFrame = useEditorStore((s) => s.currentFrame)

  const clipId = selectedClipIds[0]
  const clip = clipId ? timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) : undefined
  const clipName = clip ? (manifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? 'Clip') : ''

  const [draft, setDraft] = useState<ColorAdjustments>(makeColorAdjustments())
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [rawUrl, setRawUrl] = useState<string | null>(null)
  const [samples, setSamples] = useState<Sample[]>([])
  const [lutLib, setLutLib] = useState<string | null>(null)
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const lastClipId = useRef<string | undefined>(undefined)

  const mediaPath = clip ? expectedPath(manifest, clip.mediaRef, projectDir) : null
  const fps = timeline.fps
  const frameInClip =
    clip && currentFrame >= clip.startFrame && currentFrame < clip.startFrame + clip.durationFrames
      ? currentFrame
      : clip
        ? clip.startFrame + Math.floor(clip.durationFrames / 2)
        : 0
  const seekSeconds = clip ? clipSourceSecondsAt(clip, frameInClip, fps) : 0

  useEffect(() => {
    if (clipId === lastClipId.current) return
    lastClipId.current = clipId
    setDraft(clip?.color ? makeColorAdjustments(clip.color) : makeColorAdjustments())
    setSamples([])
  }, [clipId, clip])

  useEffect(() => {
    void window.editorBridge.colorGetLutLibrary().then(setLutLib)
  }, [])

  async function renderStill(color: ColorAdjustments, width: number): Promise<string | null> {
    if (!mediaPath) return null
    return window.editorBridge.colorStill({ mediaPath, seekSeconds, color, width, projectDir })
  }

  // Debounced EXACT preview of the current draft + the RAW reference at this shot/frame.
  useEffect(() => {
    if (!mediaPath) {
      setPreviewUrl(null)
      return
    }
    const t = setTimeout(async () => {
      const [p, r] = await Promise.all([renderStill(draft, 560), renderStill(makeColorAdjustments(), 320)])
      setPreviewUrl(p)
      setRawUrl(r)
    }, 280)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, mediaPath, seekSeconds, lutLib])

  function update(key: NumericColorKey, value: number): void {
    setActivePresetId(null)
    setDraft((d) => ({ ...d, [key]: value }) as ColorAdjustments)
  }

  function applyToClip(color: ColorAdjustments): void {
    if (clipId) getController().setClipColor(clipId, color, 'Color grade')
  }

  function loadPreset(color: ColorAdjustments, presetId?: string): void {
    const next = makeColorAdjustments(color)
    setActivePresetId(presetId ?? null)
    setDraft(next)
    applyToClip(next)
  }

  function reset(): void {
    const neutral = makeColorAdjustments()
    setDraft(neutral)
    applyToClip(neutral)
  }

  async function guardarMuestra(): Promise<void> {
    const id = crypto.randomUUID()
    const name = `Muestra ${samples.length + 1}`
    const color = makeColorAdjustments(draft)
    const url = await renderStill(color, 220)
    setSamples((s) => [...s, { id, name, color, url }])
  }

  async function elegir(): Promise<void> {
    const c = getController()
    const ids = c
      .getTimeline()
      .tracks.filter((t) => t.type !== 'audio')
      .flatMap((t) => t.clips.map((cl) => cl.id))
    if (ids.length === 0) return
    setApplying(true)
    c.transact('Aplicar look a todo el video', () => {
      for (const id of ids) c.setClipColor(id, draft)
    })
    // Verification beat: render the graded frame to confirm it composes before showing the full video.
    await renderStill(draft, 720)
    setApplying(false)
    onClose?.()
  }

  async function pickLutFolder(): Promise<void> {
    setLutLib(await window.editorBridge.colorSetLutLibrary())
  }

  const isColorable = clip && (clip.mediaType === 'video' || clip.mediaType === 'image')
  if (!clipId || !clip || !isColorable) {
    return (
      <div className="ci-empty">
        <p className="empty-sub">Selecciona un clip de video (o imagen) en la línea de tiempo para colorizar.</p>
      </div>
    )
  }

  return (
    <div className="ci-modal">
      {applying && (
        <div className="ci-loading">
          <div className="spinner" />
          <p>Colorizando todo el video…</p>
        </div>
      )}
      <div className="ci-left">
        <div className="ci-preview big">
          {previewUrl ? <img src={previewUrl} alt="preview" /> : <div className="ci-preview-empty">Preview…</div>}
          <span className="ci-preview-tag">Preview exacto · {clipName}</span>
        </div>
        <div className="ci-section">
          <h3>Comparar muestras vs crudo</h3>
          <div className="ci-gallery">
            <figure className="ci-tile">
              {rawUrl ? <img src={rawUrl} alt="crudo" /> : <div className="ci-preview-empty">—</div>}
              <figcaption>Crudo</figcaption>
            </figure>
            {samples.map((s) => (
              <figure className="ci-tile" key={s.id}>
                <button className="ci-tile-btn" title="Cargar esta muestra" onClick={() => loadPreset(s.color)}>
                  {s.url ? <img src={s.url} alt={s.name} /> : <div className="ci-preview-empty">…</div>}
                </button>
                <figcaption>{s.name}</figcaption>
              </figure>
            ))}
          </div>
        </div>
      </div>

      <div className="ci-right">
        <div className="ci-section">
          <h3>Configuraciones recomendadas</h3>
          <div className="ci-presets">
            {DOCUMENT_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`ci-preset${activePresetId === p.id ? ' active' : ''}`}
                title={p.source}
                onClick={() => loadPreset(p.color, p.id)}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="ci-looks">
            {GENERIC_LOOKS.map((l) => (
              <button
                key={l.id}
                className="ci-look"
                onClick={() => {
                  setActivePresetId(null)
                  setDraft((d) => mergeColor(d, l.patch))
                }}
              >
                {l.name}
              </button>
            ))}
          </div>
          {!lutLib && (
            <p className="ci-warn">
              Carpeta de LUTs no configurada.{' '}
              <button className="ci-link" onClick={() => void pickLutFolder()}>
                Seleccionar…
              </button>
            </p>
          )}
        </div>

        <div className="ci-section">
          <div className="ci-section-head">
            <h3>Parámetros</h3>
            <button className="ci-link" onClick={reset}>
              Reset
            </button>
          </div>
          <div className="ci-lut">
            <span>LUT</span>
            <strong title={draft.lutRef ?? ''}>
              {draft.lutRef ? parseLutRef(draft.lutRef).name.replace(/\.cube$/i, '') : 'Ninguno'}
            </strong>
            {draft.lutRef && (
              <button className="ci-link" onClick={() => setDraft((d) => ({ ...d, lutRef: undefined }))}>
                Quitar
              </button>
            )}
          </div>
          {SLIDERS.map((s) => (
            <div className="ci-row" key={s.key}>
              <label>{s.label}</label>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={Number(draft[s.key] ?? 0)}
                onChange={(e) => update(s.key, Number(e.target.value))}
              />
              <input
                type="number"
                min={s.min}
                max={s.max}
                step={s.step}
                value={Number(draft[s.key] ?? 0)}
                onChange={(e) => update(s.key, Number(e.target.value))}
              />
            </div>
          ))}
        </div>

        <div className="ci-actions">
          <button
            onClick={() => {
              applyToClip(draft)
              setAppliedMsg('✓ Aplicado a este clip')
              window.setTimeout(() => setAppliedMsg(null), 2200)
            }}
            disabled={colorIsIdentity(draft)}
          >
            Aplicar a este clip
          </button>
          <button onClick={() => void guardarMuestra()}>+ Guardar muestra</button>
          <button className="primary" onClick={() => void elegir()}>
            Elegir (aplicar a todo y cerrar)
          </button>
          {appliedMsg && <p className="ci-applied">{appliedMsg}</p>}
        </div>
      </div>
    </div>
  )
}
