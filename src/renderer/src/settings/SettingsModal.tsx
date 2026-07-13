// SPDX-License-Identifier: GPL-3.0-or-later
// Ajustes: claves API (BYOK, cifradas en main — nunca se leen de vuelta), privacidad (toggle de
// medición) y Acerca de (versión + actualizaciones). Modal autocontenido, patrón ExportPickerModal.

import { useEffect, useState } from 'react'
import type { ElevenLabsKeyStatus, UpdateStatusEvent } from '../../../shared/ipc'
import { emit, flush, setTelemetryEnabled } from '../telemetry'
import { Icon } from '../ui/Icon'

function KeyRow({
  label,
  hint,
  present,
  presentNote,
  placeholder,
  telPrefix,
  canClear,
  onSave,
  onClear
}: {
  label: string
  hint: string
  present: boolean
  /** Extra status note (e.g. "definida por variable de entorno"). */
  presentNote?: string
  placeholder: string
  telPrefix: string
  canClear: boolean
  onSave: (key: string) => Promise<void>
  onClear: () => Promise<void>
}) {
  const [input, setInput] = useState('')
  const [saving, setSaving] = useState(false)

  async function save(): Promise<void> {
    const k = input.trim()
    if (!k) return
    setSaving(true)
    try {
      await onSave(k)
      setInput('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <strong>{label}</strong>
        <span className="settings-hint">{hint}</span>
        <span className={`settings-key-status ${present ? 'ok' : ''}`}>
          {present ? `● Clave configurada${presentNote ? ` — ${presentNote}` : ''}` : '○ Sin clave'}
        </span>
      </div>
      <div className="settings-row-controls">
        <input
          type="password"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save()}
        />
        <button
          className="primary"
          data-tel={`${telPrefix}_save`}
          disabled={!input.trim() || saving}
          onClick={() => void save()}
        >
          Guardar
        </button>
        {present && canClear && (
          <button data-tel={`${telPrefix}_clear`} onClick={() => void onClear()} title="Quitar la clave guardada">
            Quitar
          </button>
        )}
      </div>
    </div>
  )
}

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [anthropicPresent, setAnthropicPresent] = useState(false)
  const [elevenStatus, setElevenStatus] = useState<ElevenLabsKeyStatus>({ present: false, source: null })
  const [telemetryOn, setTelemetryOn] = useState<boolean | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatusEvent | null>(null)

  useEffect(() => {
    void window.editorBridge.aiHasKey().then(setAnthropicPresent)
    void window.editorBridge.elevenLabsKeyStatus().then(setElevenStatus)
    void window.editorBridge.getTelemetryContext().then((ctx) => setTelemetryOn(ctx.enabled))
    void window.editorBridge.getAppVersion().then(setVersion)
    const unsubscribe = window.editorBridge.onUpdateStatus((ev) => {
      setUpdate(ev)
      if (ev.status === 'none' || ev.status === 'downloaded' || ev.status === 'error') {
        emit('io', 'io.update_check', { status: ev.status })
      }
    })
    return unsubscribe
  }, [])

  async function toggleTelemetry(on: boolean): Promise<void> {
    setTelemetryOn(on)
    if (on) {
      await window.editorBridge.setTelemetryConfig({ enabled: true })
      setTelemetryEnabled(true)
      emit('session', 'session.telemetry_toggle', { enabled: true })
    } else {
      // Emit + flush BEFORE disabling so the last event lands in the sink.
      emit('session', 'session.telemetry_toggle', { enabled: false })
      flush()
      await window.editorBridge.setTelemetryConfig({ enabled: false })
      setTelemetryEnabled(false)
    }
  }

  function checkUpdates(): void {
    void window.editorBridge.checkForUpdates().then((ev) => {
      setUpdate(ev)
      if (ev.status === 'dev') emit('io', 'io.update_check', { status: 'dev' })
    })
  }

  const updateLine = (() => {
    if (!update) return null
    switch (update.status) {
      case 'checking':
        return 'Buscando actualizaciones…'
      case 'available':
        return `Descargando la versión ${update.version ?? ''}…`
      case 'downloading':
        return `Descargando actualización… ${update.percent ?? 0}%`
      case 'downloaded':
        return `Actualización lista (v${update.version ?? ''}).`
      case 'none':
        return `Estás al día (v${update.version ?? version}).`
      case 'dev':
        return 'Disponible solo en la app instalada (esto es modo desarrollo).'
      case 'error':
        return `No se pudo buscar: ${update.error ?? 'error desconocido'}`
    }
  })()

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Ajustes</h2>
          <button className="modal-close" data-tel="settings.close" onClick={onClose} title="Cerrar">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="settings-body">
          <section className="settings-section">
            <h3>Claves API</h3>
            <p className="settings-hint">
              Se guardan cifradas en este equipo (BYOK). Nunca salen de la app ni se envían a nadie más
              que al proveedor correspondiente.
            </p>
            <KeyRow
              label="Anthropic (Claude)"
              hint="Chat de edición con IA y segmentación por guiones."
              present={anthropicPresent}
              placeholder="sk-ant-…"
              telPrefix="settings.anthropic_key"
              canClear
              onSave={async (k) => {
                await window.editorBridge.aiSetKey(k)
                setAnthropicPresent(await window.editorBridge.aiHasKey())
              }}
              onClear={async () => {
                await window.editorBridge.aiClearKey()
                setAnthropicPresent(false)
              }}
            />
            <KeyRow
              label="ElevenLabs"
              hint="Transcripción (Scribe), corte por silencios con transcript y aislamiento de voz."
              present={elevenStatus.present}
              presentNote={
                elevenStatus.source === 'env' ? 'definida por variable de entorno (.env), tiene prioridad' : undefined
              }
              placeholder="clave de ElevenLabs…"
              telPrefix="settings.elevenlabs_key"
              canClear={elevenStatus.source !== 'env'}
              onSave={async (k) => {
                await window.editorBridge.elevenLabsSetKey(k)
                setElevenStatus(await window.editorBridge.elevenLabsKeyStatus())
              }}
              onClear={async () => {
                await window.editorBridge.elevenLabsClearKey()
                setElevenStatus(await window.editorBridge.elevenLabsKeyStatus())
              }}
            />
          </section>

          <section className="settings-section">
            <h3>Privacidad</h3>
            <label className="settings-toggle">
              <input
                type="checkbox"
                data-tel="settings.telemetry_toggle"
                checked={telemetryOn ?? false}
                disabled={telemetryOn === null}
                onChange={(e) => void toggleTelemetry(e.target.checked)}
              />
              <span>
                Medición de uso local
                <span className="settings-hint">
                  Registra QUÉ funciones se usan (clics, comandos, tiempos) para mejorar la app. Nunca
                  el contenido: ni video, ni audio, ni textos, ni nombres de archivo. Los datos quedan
                  solo en este equipo. Se aplica por completo al reiniciar la app.
                </span>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <h3>Acerca de</h3>
            <p className="settings-about">
              Reelo v{version || '…'} · GPL-3.0 — editor de video AI-native.
            </p>
            <div className="settings-row-controls">
              <button data-tel="settings.check_updates" onClick={checkUpdates} disabled={update?.status === 'checking'}>
                <Icon name="download" size={14} /> Buscar actualizaciones
              </button>
              {update?.status === 'downloaded' && (
                <button
                  className="primary"
                  data-tel="settings.restart_update"
                  onClick={() => void window.editorBridge.installUpdate()}
                >
                  Reiniciar y actualizar
                </button>
              )}
            </div>
            {updateLine && <p className="settings-hint">{updateLine}</p>}
          </section>
        </div>
      </div>
    </div>
  )
}
