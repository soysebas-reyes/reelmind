// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer telemetry entry point. Called once at module scope from main.tsx (outside React, so
// React.StrictMode's double-mount can't double-install). Fetches identity+config from main, then
// installs all capture layers only when enabled — zero overhead when telemetry is off.

import { initTelemetryClient, emit } from './client'
import { installDwell } from './dwell'
import { installPhysical } from './physical'
import { installSemantic } from './semantic'
import { installStoreTelemetry } from './io'

let started = false

export async function initTelemetry(): Promise<void> {
  if (started) return
  started = true
  try {
    const ctx = await window.editorBridge.getTelemetryContext()
    initTelemetryClient(ctx)
    if (!ctx.enabled) return
    installSemantic() // command commits (EditorController)
    installStoreTelemetry() // io/orchestration store actions
    installDwell() // time-on-panel / idle / heartbeat
    installPhysical() // clicks, pointer, keys, wheel
    emit('session', 'session.start', {})
  } catch {
    // Telemetry bridge unavailable → the app runs normally, unmeasured.
  }
}

export { emit }
export { flush, isTelemetryEnabled, setTelemetryEnabled } from './client'
