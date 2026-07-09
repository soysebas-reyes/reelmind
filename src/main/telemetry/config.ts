// SPDX-License-Identifier: GPL-3.0-or-later
// Telemetry config in userData (same sync-JSON style as colorSettings.ts). Local default =
// ENABLED (local-only, zero network egress in v1). Kill switch: REELMIND_NO_TELEMETRY=1.
// NOTE (future/cloud): the local phase is opt-OUT; the first Supabase upload must be opt-IN
// behind explicit consent + a published privacy policy (see docs/TOTAL_MEASUREMENT_PLAN.md).

import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TelemetryConfig } from '@core'

const DEFAULT: TelemetryConfig = { enabled: true, sampleRates: {} }

function cfgPath(): string {
  return join(app.getPath('userData'), 'telemetryConfig.json')
}

export function readConfig(): TelemetryConfig {
  if (process.env.REELMIND_NO_TELEMETRY) return { ...DEFAULT, enabled: false }
  try {
    const raw = JSON.parse(readFileSync(cfgPath(), 'utf8')) as Partial<TelemetryConfig>
    return { ...DEFAULT, ...raw }
  } catch {
    return { ...DEFAULT }
  }
}

export function writeConfig(patch: Partial<TelemetryConfig>): TelemetryConfig {
  const next: TelemetryConfig = { ...readConfig(), ...patch }
  if (process.env.REELMIND_NO_TELEMETRY) next.enabled = false // env kill switch always wins
  try {
    writeFileSync(cfgPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // non-fatal
  }
  return next
}
