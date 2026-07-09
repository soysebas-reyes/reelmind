// SPDX-License-Identifier: GPL-3.0-or-later
// End-to-end data-layer check for the telemetry sink + the privacy backstop:
// events (some carrying paths/emails in props) → redactProps → real JsonlSink → read back.
// Asserts the written JSONL is valid, schema-passing, and PII-free (the "redaction audit").

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TELEMETRY_SCHEMA_VERSION,
  type TelemetryCategory,
  type TelemetryEvent,
  newId,
  redactProps,
  telemetryEventSchema
} from '@core'
import { JsonlSink } from './jsonlSink'

function ev(name: string, category: TelemetryCategory, props?: Record<string, unknown>): TelemetryEvent {
  return {
    v: TELEMETRY_SCHEMA_VERSION,
    id: newId(),
    name,
    category,
    ts: 1_700_000_000_000,
    sessionId: 's1',
    anonymousId: 'a1',
    appVersion: '0.0.1',
    platform: 'win32',
    props: redactProps(props)
  }
}

describe('JsonlSink round-trip + redaction audit', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'reelmind-tel-'))
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes valid, schema-passing, PII-free JSONL', async () => {
    const sink = new JsonlSink(dir)
    const events = [
      ev('session.start', 'session', { platform: 'win32' }),
      ev('command.split_clip', 'command', { origin: 'user', coalesced: false }),
      ev('tool.export', 'tool', { origin: 'agent', ok: true, ms: 120, args: 'outputPath' }),
      ev('io.saveProject', 'io', {
        name: 'saveProject',
        ok: true,
        // Hostile props that MUST be scrubbed before ever touching disk:
        path: 'D:\\crudos\\toma1.mp4',
        dir: 'C:/Users/sebas/proyecto secreto',
        url: 'https://example.com/leak',
        email: 'sebas@example.com'
      })
    ]
    await sink.append(events)
    await sink.flush()
    await sink.close()

    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    expect(files.length).toBeGreaterThan(0)
    const raw = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    expect(lines).toHaveLength(events.length)

    // Every written line parses and passes the wire schema (as main would re-validate it).
    for (const line of lines) {
      expect(telemetryEventSchema.safeParse(JSON.parse(line)).success).toBe(true)
    }

    // Redaction audit: no path/media/URL/email fragment survived to disk.
    for (const needle of ['toma1.mp4', 'C:/Users', 'proyecto secreto', 'example.com', '.mp4', 'crudos']) {
      expect(raw.includes(needle), `PII fragment leaked to JSONL: ${needle}`).toBe(false)
    }
    expect(raw).toContain('[redacted:path]')
    expect(raw).toContain('[redacted:email]')
    // Safe behavioral fields are preserved.
    expect(raw).toContain('saveProject')
    expect(raw).toContain('command.split_clip')
  })
})
