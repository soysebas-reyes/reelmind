// SPDX-License-Identifier: GPL-3.0-or-later
// Telemetry wiring in the main process: identity + config + local JSONL sink + IPC receiver +
// invoke handlers + flush-on-quit. Called once from app.whenReady() (after registerIpc, before
// createWindow) so identity/config exist before the renderer requests context. Behavioral events
// ONLY — main is the trust boundary and overwrites identity/version, and validates every payload.

import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import {
  TELEMETRY_SCHEMA_VERSION,
  telemetryEventSchema,
  type TelemetryConfig,
  type TelemetryContext,
  type TelemetryEvent
} from '@core'
import { loadIdentity } from './identity'
import { readConfig, writeConfig } from './config'
import { JsonlSink } from './jsonlSink'
import { readRecent } from './reader'
import type { TelemetrySink } from './sink'

const BATCH_MAX = 500
const batchSchema = z.array(telemetryEventSchema).max(BATCH_MAX)

let sink: TelemetrySink | null = null
let started = false

export function initTelemetry(): void {
  if (started) return
  started = true

  const identity = loadIdentity()
  let config = readConfig()
  const dir = join(app.getPath('userData'), 'telemetry')
  sink = new JsonlSink(dir)

  // Fire-and-forget ingest (mirrors mcp:execute:result). Never throws across IPC.
  ipcMain.on('telemetry:events', (_e, payload: unknown) => {
    if (!config.enabled || !sink) return
    const parsed = batchSchema.safeParse(payload)
    if (!parsed.success) return // drop malformed batch silently
    const now = Date.now()
    // Main is the trust boundary: overwrite identity/version/appVersion, clamp implausible clocks.
    const events: TelemetryEvent[] = parsed.data.map((ev) => ({
      ...ev,
      v: TELEMETRY_SCHEMA_VERSION,
      anonymousId: identity.anonymousId,
      userId: identity.userId,
      appVersion: app.getVersion(),
      platform: process.platform,
      ts: ev.ts > 0 && ev.ts <= now + 60_000 ? ev.ts : now
    }))
    void sink.append(events)
  })

  ipcMain.handle('telemetry:getContext', (): TelemetryContext => ({
    enabled: config.enabled,
    sampleRates: config.sampleRates ?? {},
    sessionId: identity.sessionId,
    anonymousId: identity.anonymousId,
    userId: identity.userId,
    appVersion: app.getVersion(),
    platform: process.platform,
    noticeAckAt: config.noticeAckAt
  }))

  ipcMain.handle('telemetry:setConfig', (_e, patch: Partial<TelemetryConfig>): TelemetryConfig => {
    config = writeConfig(patch ?? {})
    return config
  })

  ipcMain.handle('telemetry:recent', (_e, limit: unknown): TelemetryEvent[] => {
    const n = typeof limit === 'number' && limit > 0 ? Math.min(limit, 5000) : 200
    return readRecent(dir, n)
  })

  // Final synchronous flush so the last events land before the process exits.
  app.on('before-quit', () => {
    if (sink) void sink.close()
  })
}
