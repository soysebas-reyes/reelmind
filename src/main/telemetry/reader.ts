// SPDX-License-Identifier: GPL-3.0-or-later
// Dev inspection: read the tail of recent JSONL telemetry (local only, no network).
// Backs the getRecentTelemetry bridge method so a settings/debug UI can show recent activity.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TelemetryEvent } from '@core'

/** Return up to `limit` most-recent events, newest first, tolerating torn trailing lines. */
export function readRecent(dir: string, limit: number): TelemetryEvent[] {
  const out: TelemetryEvent[] = []
  try {
    const files = readdirSync(dir)
      .filter((f) => /^events-.*\.jsonl$/.test(f))
      .sort()
      .reverse() // newest day/shard first
    for (const f of files) {
      const lines = readFileSync(join(dir, f), 'utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        try {
          out.push(JSON.parse(line) as TelemetryEvent)
        } catch {
          continue // torn/partial line
        }
        if (out.length >= limit) return out
      }
    }
  } catch {
    /* non-fatal */
  }
  return out
}
