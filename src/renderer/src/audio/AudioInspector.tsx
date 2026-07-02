// SPDX-License-Identifier: GPL-3.0-or-later
// "Realzar audio" explorer — a PREVIEW/STAGING modal (mirrors ColorInspector). Flow:
//   1. "Generar preview" isolates the 8 s snippet at the playhead with ElevenLabs (current Intensidad +
//      Quitar fondo). This is the ONLY thing that spends ElevenLabs credit, and only on click.
//   2. The manual DSP params (EQ/compresión/limitador/volumen) modify the "Mejorado" preview LIVE via a
//      Web Audio graph — no re-render, no extra credit.
//   3. Changing the IA params marks the preview stale → press "Generar preview" again to re-run ElevenLabs.
// Nothing touches the clip on the timeline until "Aplicar al clip", which runs the AI isolation on the
// FULL clip (if enabled) and stores the manual DSP settings. Only operates on AUDIO clips.

import { useEffect, useRef, useState } from 'react'
import {
  type AudioEnhanceSettings,
  AUDIO_PRESETS,
  clipSourceSecondsAt,
  expectedPath,
  makeAudioEnhance
} from '@core'
import { getController, useEditorStore } from '../store'
import { applyAudioEnhance } from './audioGraph'
import { Icon } from '../ui/Icon'

type BoolKey = 'gate' | 'denoise' | 'deEss' | 'limiter'
type NumericKey = Exclude<keyof AudioEnhanceSettings, 'enabled' | BoolKey>

interface SliderDef {
  key: NumericKey
  label: string
  min: number
  max: number
  step: number
  /** Only enabled when this boolean toggle is on. */
  needs?: BoolKey
}

interface Group {
  title: string
  toggles: { key: BoolKey; label: string }[]
  sliders: SliderDef[]
}

const GROUPS: Group[] = [
  {
    title: 'Ruido',
    toggles: [
      { key: 'gate', label: 'Compuerta de ruido' },
      { key: 'denoise', label: 'Reducir ruido' }
    ],
    sliders: [
      { key: 'gateThresholdDb', label: 'Umbral compuerta (dB)', min: -80, max: -20, step: 1, needs: 'gate' },
      { key: 'denoiseAmount', label: 'Reducción de ruido (dB)', min: 0, max: 40, step: 1, needs: 'denoise' }
    ]
  },
  {
    title: 'Ecualización',
    toggles: [],
    sliders: [
      { key: 'highpassHz', label: 'Paso-altos / quitar retumbe (Hz)', min: 0, max: 200, step: 5 },
      { key: 'lowpassHz', label: 'Paso-bajos / quitar silbido (Hz)', min: 0, max: 20000, step: 500 },
      { key: 'lowShelfDb', label: 'Graves / cuerpo (dB)', min: -12, max: 12, step: 1 },
      { key: 'mudDb', label: 'Quitar "lodo" ~250 Hz (dB)', min: -12, max: 0, step: 1 },
      { key: 'presenceDb', label: 'Presencia / claridad ~4 kHz (dB)', min: -6, max: 12, step: 1 },
      { key: 'airDb', label: 'Aire / brillo ~12 kHz (dB)', min: -6, max: 12, step: 1 }
    ]
  },
  {
    title: 'Sibilancia',
    toggles: [{ key: 'deEss', label: 'De-esser (suavizar "s")' }],
    sliders: [{ key: 'deEssAmount', label: 'Intensidad de-esser', min: 0, max: 1, step: 0.05, needs: 'deEss' }]
  },
  {
    title: 'Dinámica',
    toggles: [{ key: 'limiter', label: 'Limitador (controlar picos)' }],
    sliders: [
      { key: 'compThreshold', label: 'Umbral compresión (dB)', min: -40, max: 0, step: 1 },
      { key: 'compRatio', label: 'Ratio compresión', min: 1, max: 10, step: 0.5 },
      { key: 'compAttack', label: 'Ataque (ms)', min: 1, max: 100, step: 1 },
      { key: 'compRelease', label: 'Liberación (ms)', min: 20, max: 1000, step: 10 },
      { key: 'compMakeupDb', label: 'Ganancia de compensación (dB)', min: 0, max: 12, step: 0.5 },
      { key: 'limitDb', label: 'Techo del limitador (dB)', min: -3, max: 0, step: 0.1, needs: 'limiter' }
    ]
  },
  {
    title: 'Volumen final',
    toggles: [],
    sliders: [
      { key: 'targetLufs', label: 'Volumen objetivo (LUFS)', min: -24, max: -9, step: 1 },
      { key: 'outputGainDb', label: 'Ganancia de salida (dB)', min: -12, max: 12, step: 0.5 }
    ]
  }
]

const PREVIEW_SECONDS = 8

/** Convert a `data:audio/…;base64,…` URL into a `blob:` object URL. The renderer's CSP `media-src`
 *  allows `blob:` but NOT `data:`, so <audio> can't load data URLs directly. Caller revokes the URL. */
function dataUrlToBlobUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'))
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime || 'audio/mp4' }))
}

/** Fresh manual-DSP draft for a clip with no stored settings: Voz preset values but OFF by default, so a
 *  one-click "Aplicar al clip" does AI-only unless the user turns manual on. */
function freshDraft(): AudioEnhanceSettings {
  return { ...makeAudioEnhance(AUDIO_PRESETS[0].settings), enabled: false }
}

export default function AudioInspector({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const timeline = useEditorStore((s) => s.timeline)
  const manifest = useEditorStore((s) => s.manifest)
  const projectDir = useEditorStore((s) => s.projectDir)
  const currentFrame = useEditorStore((s) => s.currentFrame)

  const clipId = selectedClipIds[0]
  const clip = clipId ? timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId) : undefined
  const clipName = clip ? (manifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? 'Clip') : ''

  // PREVIEW/STAGING state only — nothing here writes to the clip until "Aplicar al clip".
  const [draft, setDraft] = useState<AudioEnhanceSettings>(freshDraft)
  const [useAI, setUseAI] = useState(true)
  const [aiIntensity, setAiIntensity] = useState(80) // CapCut-style dry/wet blend
  const [aiDenoise, setAiDenoise] = useState(70) // constant-background (fan) reduction
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [mejoradoUrl, setMejoradoUrl] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [hasPreview, setHasPreview] = useState(false)
  const [stale, setStale] = useState(false) // IA params changed since the last preview
  const [applying, setApplying] = useState(false)
  const [activePresetId, setActivePresetId] = useState<string | null>(null)
  const lastClipId = useRef<string | undefined>(undefined)
  const mejoradoRef = useRef<HTMLAudioElement | null>(null)
  // Live blob: object URLs for the A/B players; revoked when replaced or on unmount.
  const blobUrlsRef = useRef<string[]>([])
  const revokeBlobs = (): void => {
    for (const u of blobUrlsRef.current) URL.revokeObjectURL(u)
    blobUrlsRef.current = []
  }
  const trackBlob = (url: string): string => {
    blobUrlsRef.current.push(url)
    return url
  }
  useEffect(() => () => revokeBlobs(), [])

  const mediaPath = clip ? expectedPath(manifest, clip.mediaRef, projectDir) : null
  const fps = timeline.fps
  const frameInClip =
    clip && currentFrame >= clip.startFrame && currentFrame < clip.startFrame + clip.durationFrames
      ? currentFrame
      : clip
        ? clip.startFrame + Math.floor(clip.durationFrames / 2)
        : 0
  const seekSeconds = clip ? clipSourceSecondsAt(clip, frameInClip, fps) : 0

  // Reset everything when the selected clip changes.
  useEffect(() => {
    if (clipId === lastClipId.current) return
    lastClipId.current = clipId
    const stored = clip?.audioEnhance
    setDraft(stored ? makeAudioEnhance(stored) : freshDraft())
    setActivePresetId(null)
    revokeBlobs()
    setOriginalUrl(null)
    setMejoradoUrl(null)
    setHasPreview(false)
    setStale(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipId])

  // Changing the IA params invalidates the rendered preview (it must re-run ElevenLabs to reflect them).
  useEffect(() => {
    if (hasPreview) setStale(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiIntensity, aiDenoise, useAI])

  // Manual DSP modifies the "Mejorado" preview LIVE via Web Audio (EQ/compressor/limiter/gain) — no
  // re-render, no extra credit. afftdn/gate/loudnorm are approximated here and rendered exactly on apply.
  useEffect(() => {
    if (!mejoradoUrl || !mejoradoRef.current) return
    applyAudioEnhance(mejoradoRef.current, draft.enabled ? draft : undefined)
  }, [mejoradoUrl, draft])

  /** Render the 8 s A/B preview: ElevenLabs-isolate the snippet (if AI on), else just the raw snippet.
   *  The ONLY paid call, and only on click. */
  async function generatePreview(): Promise<void> {
    if (!mediaPath) return
    setGenerating(true)
    try {
      let rawUrl: string | null = null
      let mejUrl: string | null = null
      if (useAI) {
        const r = await window.editorBridge.previewIsolateVoice({
          srcPath: mediaPath,
          startSec: seekSeconds,
          durationSec: PREVIEW_SECONDS,
          intensity: aiIntensity / 100,
          denoise: aiDenoise / 100
        })
        if (!r.ok) {
          alert('No se pudo generar el preview: ' + (r.error ?? ''))
          return
        }
        rawUrl = r.rawDataUrl ? trackBlob(dataUrlToBlobUrl(r.rawDataUrl)) : null
        mejUrl = r.isolatedDataUrl ? trackBlob(dataUrlToBlobUrl(r.isolatedDataUrl)) : null
      } else {
        // No AI: the "Mejorado" base is the raw snippet; manual DSP rides on top via Web Audio.
        const r = await window.editorBridge.enhanceAudioPreview({
          srcPath: mediaPath,
          startSec: seekSeconds,
          durationSec: PREVIEW_SECONDS,
          settings: draft
        })
        if (!r.ok) {
          alert('No se pudo generar el preview: ' + (r.error ?? ''))
          return
        }
        rawUrl = r.rawDataUrl ? trackBlob(dataUrlToBlobUrl(r.rawDataUrl)) : null
        mejUrl = rawUrl
      }
      revokeOld(rawUrl, mejUrl)
      setOriginalUrl(rawUrl)
      setMejoradoUrl(mejUrl)
      setHasPreview(true)
      setStale(false)
    } finally {
      setGenerating(false)
    }
  }
  // Revoke prior blobs except the two we're keeping.
  function revokeOld(keepA: string | null, keepB: string | null): void {
    const keep = new Set([keepA, keepB].filter(Boolean) as string[])
    blobUrlsRef.current = blobUrlsRef.current.filter((u) => {
      if (keep.has(u)) return true
      URL.revokeObjectURL(u)
      return false
    })
  }

  // ---- Draft mutators (preview state only; never the clip) ----
  function update(key: NumericKey, value: number): void {
    setActivePresetId(null)
    setDraft((d) => ({ ...d, [key]: value }) as AudioEnhanceSettings)
  }
  function toggleBool(key: BoolKey, value: boolean): void {
    setActivePresetId(null)
    setDraft((d) => ({ ...d, [key]: value }))
  }
  function loadPreset(settings: AudioEnhanceSettings, presetId: string): void {
    setActivePresetId(presetId)
    setDraft({ ...makeAudioEnhance(settings), enabled: true })
  }
  function setEnabled(value: boolean): void {
    setDraft((d) => ({ ...d, enabled: value }))
  }

  function cancel(): void {
    onClose?.() // discard — nothing was written to the clip
  }

  /** THE commit: the only thing that changes the clip. Runs AI isolation on the FULL clip (if on), then
   *  stores the manual DSP settings, then closes. */
  async function applyToClip(): Promise<void> {
    if (!clipId) return
    setApplying(true)
    try {
      if (useAI) {
        const r = await useEditorStore.getState().isolateClipVoice(clipId, aiIntensity / 100, aiDenoise / 100)
        if (!r.ok) return
      }
      getController().setClipAudioEnhance(clipId, draft)
    } finally {
      setApplying(false)
    }
    onClose?.()
  }

  const isAudio = clip && clip.mediaType === 'audio'
  if (!clipId || !clip || !isAudio) {
    return (
      <div className="ci-empty">
        <p className="empty-sub">
          Selecciona un clip en una <strong>pista de audio</strong> para realzarlo. (Si sincronizaste ángulos, el
          audio quedó en su propia pista.)
        </p>
      </div>
    )
  }

  return (
    <div className="ci-modal">
      <div className="ci-left">
        <div className="ae-ab">
          <h3>Escuchar A/B {generating && <span className="ae-rendering">· generando…</span>}</h3>
          <p className="export-note">
            Fragmento de {PREVIEW_SECONDS}s desde el punto de reproducción · {clipName}
          </p>
          <button className="primary" onClick={() => void generatePreview()} disabled={generating}>
            {generating ? (
              'Generando preview…'
            ) : (
              <>
                <Icon name="sparkles" size={15} /> {hasPreview ? 'Regenerar preview' : 'Generar preview'}
              </>
            )}
          </button>
          {stale && <p className="ci-warn">Cambiaste parámetros de IA — vuelve a generar el preview para oírlos.</p>}
          <div className="ae-player">
            <span className="ae-tag">Original</span>
            {originalUrl ? <audio src={originalUrl} controls preload="auto" /> : <div className="ci-preview-empty">—</div>}
          </div>
          <div className="ae-player">
            <span className="ae-tag enhanced">Mejorado</span>
            {mejoradoUrl ? (
              <audio ref={mejoradoRef} src={mejoradoUrl} controls preload="auto" />
            ) : (
              <div className="ci-preview-empty">Pulsa “Generar preview” para escuchar</div>
            )}
          </div>
          <p className="export-note">
            El ajuste manual (EQ/compresión/volumen) modifica el “Mejorado” en vivo (aproximado). El
            aislamiento por IA solo se renderiza al pulsar “Generar preview”. Al aplicar, todo se renderiza
            exacto. Nada cambia en el timeline hasta “Aplicar al clip”.
          </p>
        </div>
      </div>

      <div className="ci-right">
        <div className="ci-section">
          <h3>Realce con IA</h3>
          <label className="ae-check">
            <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
            Aislar voz con IA (ElevenLabs)
          </label>
          <div className={`ci-row${useAI ? '' : ' ae-disabled'}`}>
            <label>Intensidad ({aiIntensity}%)</label>
            <input type="range" min={0} max={100} step={5} disabled={!useAI} value={aiIntensity} onChange={(e) => setAiIntensity(Number(e.target.value))} />
            <input type="number" min={0} max={100} step={5} disabled={!useAI} value={aiIntensity} onChange={(e) => setAiIntensity(Number(e.target.value))} />
          </div>
          <div className={`ci-row${useAI ? '' : ' ae-disabled'}`}>
            <label>Quitar fondo ({aiDenoise}%)</label>
            <input type="range" min={0} max={100} step={5} disabled={!useAI} value={aiDenoise} onChange={(e) => setAiDenoise(Number(e.target.value))} />
            <input type="number" min={0} max={100} step={5} disabled={!useAI} value={aiDenoise} onChange={(e) => setAiDenoise(Number(e.target.value))} />
          </div>
          <p className="export-note">
            Intensidad: 100% = voz totalmente aislada (puede sonar “muerta”), ~80% mantiene ambiente natural.
            Quitar fondo: elimina el ruido constante (ventilador/aire); súbelo si persiste, bájalo si la voz
            suena “burbujeante”.
          </p>
        </div>

        <div className="ci-section">
          <h3>Ajuste manual (opcional)</h3>
          <label className="ae-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Activar ajuste manual (EQ, compresión, volumen)
          </label>
          <div className="ci-presets">
            {AUDIO_PRESETS.map((p) => (
              <button key={p.id} className={`ci-preset${activePresetId === p.id ? ' active' : ''}`} onClick={() => loadPreset(p.settings, p.id)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>

        {GROUPS.map((group) => (
          <div className={`ci-section${draft.enabled ? '' : ' ae-disabled'}`} key={group.title}>
            <h3>{group.title}</h3>
            {group.toggles.map((tg) => (
              <label className="ae-check" key={tg.key}>
                <input type="checkbox" checked={draft[tg.key]} disabled={!draft.enabled} onChange={(e) => toggleBool(tg.key, e.target.checked)} />
                {tg.label}
              </label>
            ))}
            {group.sliders.map((s) => {
              const disabled = !draft.enabled || (s.needs ? !draft[s.needs] : false)
              return (
                <div className={`ci-row${disabled ? ' ae-disabled' : ''}`} key={s.key}>
                  <label>{s.label}</label>
                  <input type="range" min={s.min} max={s.max} step={s.step} disabled={disabled} value={Number(draft[s.key])} onChange={(e) => update(s.key, Number(e.target.value))} />
                  <input type="number" min={s.min} max={s.max} step={s.step} disabled={disabled} value={Number(draft[s.key])} onChange={(e) => update(s.key, Number(e.target.value))} />
                </div>
              )
            })}
          </div>
        ))}

        <div className="ci-actions">
          <p className="export-note" style={{ marginTop: 0 }}>
            Reemplaza el audio del clip {useAI ? 'con la voz aislada por IA ' : ''}y guarda los ajustes. Solo al
            pulsar este botón.
          </p>
          <button className="primary" onClick={() => void applyToClip()} disabled={applying}>
            {applying ? 'Aplicando…' : 'Aplicar al clip'}
          </button>
          <button onClick={cancel} disabled={applying}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  )
}
