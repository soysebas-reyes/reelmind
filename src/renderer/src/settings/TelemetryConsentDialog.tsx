// SPDX-License-Identifier: GPL-3.0-or-later
// Aviso de medición en el primer arranque: explica QUÉ se mide (comportamiento, 100% local) y deja
// desactivarlo en un clic. Se muestra una sola vez por instalación (config.noticeAckAt); el toggle
// permanente vive en Ajustes → Privacidad.

import { useEffect, useState } from 'react'
import { emit, flush, setTelemetryEnabled } from '../telemetry'

export function TelemetryConsentDialog(): React.JSX.Element | null {
  const [show, setShow] = useState(false)

  useEffect(() => {
    void window.editorBridge.getTelemetryContext().then((ctx) => {
      // Nothing to notify when the kill switch / config already disabled measurement.
      if (ctx.enabled && !ctx.noticeAckAt) {
        setShow(true)
        emit('session', 'session.consent_shown', {})
      }
    })
  }, [])

  if (!show) return null

  async function choose(keepEnabled: boolean): Promise<void> {
    emit('session', 'session.consent_choice', { enabled: keepEnabled })
    flush()
    await window.editorBridge.setTelemetryConfig({
      noticeAckAt: new Date().toISOString(),
      ...(keepEnabled ? {} : { enabled: false })
    })
    if (!keepEnabled) setTelemetryEnabled(false)
    setShow(false)
  }

  return (
    <div className="modal-backdrop modal-backdrop-front">
      <div className="modal export-modal consent-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Medición de uso (local)</h2>
        <p className="export-note" style={{ textAlign: 'left' }}>
          Para mejorar ReelMind, la app registra <strong>qué funciones se usan</strong>: clics, comandos,
          herramientas de IA y tiempos de uso.
        </p>
        <p className="export-note" style={{ textAlign: 'left' }}>
          <strong>Nunca</strong> se registra contenido: ni video, ni audio, ni transcripciones, ni textos
          del chat, ni nombres o rutas de archivos. Los datos quedan <strong>solo en este equipo</strong> —
          no se envían por internet.
        </p>
        <p className="export-note" style={{ textAlign: 'left' }}>
          Podés cambiarlo cuando quieras en <strong>Ajustes → Privacidad</strong>.
        </p>
        <div className="export-actions">
          <button className="primary" data-tel="consent.accept" onClick={() => void choose(true)}>
            Entendido
          </button>
          <button data-tel="consent.disable" onClick={() => void choose(false)}>
            Desactivar medición
          </button>
        </div>
      </div>
    </div>
  )
}
