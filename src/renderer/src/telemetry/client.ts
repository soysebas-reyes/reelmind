// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer telemetry client: builds envelopes, redacts props (via @core), buffers, and flushes
// batched events to main over one fire-and-forget IPC. Never throws into the app; a no-op until
// initialized/enabled. Behavioral events only — see docs/TOTAL_MEASUREMENT_PLAN.md.

import {
  TELEMETRY_SCHEMA_VERSION,
  newId,
  redactProps,
  type TelemetryCategory,
  type TelemetryContext,
  type TelemetryEvent
} from '@core'

const BUFFER_MAX = 500
const FLUSH_SIZE = 64
const FLUSH_MS = 5000

let ctx: TelemetryContext | null = null
let enabled = false
let buffer: TelemetryEvent[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null

/** Sampling: a rate keyed by exact event name or by category (0..1). Absent → always keep. */
function keep(name: string, category: TelemetryCategory): boolean {
  const rates = ctx?.sampleRates ?? {}
  const rate = rates[name] ?? rates[category]
  if (rate === undefined) return true
  return Math.random() < rate
}

export function initTelemetryClient(context: TelemetryContext): void {
  ctx = context
  enabled = context.enabled
  if (!enabled) return
  if (!flushTimer) flushTimer = setInterval(flush, FLUSH_MS)
  // Flush on the reliable teardown signals (more dependable than beforeunload in Electron).
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
}

export function isTelemetryEnabled(): boolean {
  return enabled && ctx !== null
}

export function setTelemetryEnabled(on: boolean): void {
  enabled = on
  if (!on) buffer = []
}

/** Build → redact → buffer one event. Safe to call anytime; a no-op when disabled. */
export function emit(category: TelemetryCategory, name: string, props?: Record<string, unknown>): void {
  if (!enabled || !ctx) return
  if (!keep(name, category)) return
  try {
    const ev: TelemetryEvent = {
      v: TELEMETRY_SCHEMA_VERSION,
      id: newId(),
      name,
      category,
      ts: Date.now(),
      sessionId: ctx.sessionId,
      anonymousId: ctx.anonymousId,
      userId: ctx.userId,
      appVersion: ctx.appVersion,
      platform: ctx.platform,
      props: redactProps(props)
    }
    buffer.push(ev)
    if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX) // drop oldest
    if (buffer.length >= FLUSH_SIZE) flush()
  } catch {
    // telemetry must never break the app
  }
}

/** Send the buffered batch to main (fire-and-forget). */
export function flush(): void {
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []
  try {
    window.editorBridge.logTelemetryBatch(batch)
  } catch {
    // drop on failure (avoid unbounded memory growth)
  }
}
