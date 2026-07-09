// SPDX-License-Identifier: GPL-3.0-or-later
// Time-on-panel, idle detection, active vs total session time, and a periodic heartbeat.
// Module-scoped state (NOT the Zustand store — telemetry must not trigger React renders).
// Fed by the physical layer's already-captured events (no second set of DOM listeners).

import { emit } from './client'

const IDLE_MS = 60_000
const HEARTBEAT_MS = 15_000

let currentPanel: string | null = null
let panelEnterTs = 0
let lastActivityTs = 0
let idle = false
let visible = true
let activeMs = 0
let idleMs = 0
let lastTickTs = 0
let sinceHeartbeat = 0
let ticker: ReturnType<typeof setInterval> | null = null

/** Any recorded interaction; clears idle. */
export function onActivity(): void {
  lastActivityTs = Date.now()
  if (idle) {
    idle = false
    emit('session', 'session.resume', {})
  }
}

/** Panel focus/hover changed; emits a dwell event for the panel just left. */
export function onPanel(panel: string | null): void {
  if (panel === currentPanel) return
  const t = Date.now()
  if (currentPanel && panelEnterTs) {
    emit('physical', 'physical.dwell', { panel: currentPanel, ms: t - panelEnterTs, active: !idle })
  }
  currentPanel = panel
  panelEnterTs = t
}

export function onVisibility(vis: boolean): void {
  visible = vis
  if (!vis) onPanel(null) // close the open dwell + pause accumulation
}

export function installDwell(): void {
  const t = Date.now()
  lastActivityTs = t
  lastTickTs = t
  ticker = setInterval(tick, 1000)
  window.addEventListener('pagehide', () => {
    onPanel(null)
    emitHeartbeat('session.end')
    if (ticker) clearInterval(ticker)
  })
}

function tick(): void {
  const t = Date.now()
  const dt = t - lastTickTs
  lastTickTs = t
  if (!idle && visible) activeMs += dt
  else idleMs += dt
  if (!idle && t - lastActivityTs > IDLE_MS) {
    idle = true
    emit('session', 'session.idle', {})
  }
  sinceHeartbeat += dt
  if (sinceHeartbeat >= HEARTBEAT_MS) {
    sinceHeartbeat = 0
    emitHeartbeat('session.heartbeat')
  }
}

function emitHeartbeat(name: 'session.heartbeat' | 'session.end'): void {
  emit('session', name, {
    activeMs: Math.round(activeMs),
    idleMs: Math.round(idleMs),
    totalMs: Math.round(activeMs + idleMs),
    visible
  })
}
