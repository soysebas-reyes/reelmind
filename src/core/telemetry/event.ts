// SPDX-License-Identifier: GPL-3.0-or-later
// Telemetry event envelope — the SINGLE source of truth for the wire shape.
// Behavioral/usage events ONLY. Never video content or PII (see redact.ts + the
// privacy contract in docs/TOTAL_MEASUREMENT_PLAN.md).

import { z } from 'zod'

/** Bumped when the envelope/wire shape changes; lets a later reader/migration adapt. */
export const TELEMETRY_SCHEMA_VERSION = 1

/** Coarse bucket for cheap filtering/aggregation. */
export type TelemetryCategory = 'session' | 'physical' | 'command' | 'tool' | 'io' | 'error' | 'perf'

/** Redacted, allowlisted payload — safe primitives only. Never nested objects/arrays. */
export type TelemetryProps = Record<string, string | number | boolean | null>

/**
 * One measured event. The ENVELOPE (v, id, name, category, ts, identity, appVersion) is common
 * to every event; `props` is the redacted, primitive-only payload. Maps 1:1 to the future
 * Supabase `events` row (see TOTAL_MEASUREMENT_PLAN.md §Supabase).
 */
export interface TelemetryEvent {
  /** Wire schema version at emit time (= TELEMETRY_SCHEMA_VERSION). */
  v: number
  /** Idempotency key (uuid) — the dedupe key for at-least-once upload later. */
  id: string
  /** Stable dotted action id, e.g. 'command.split_clip', 'tool.export', 'physical.click'. */
  name: string
  category: TelemetryCategory
  /** ms epoch, stamped at the event site. */
  ts: number
  /** Per-launch id (shared across windows). */
  sessionId: string
  /** Persistent per-install id — the FUTURE foreign key to a user account. */
  anonymousId: string
  /** Present only once accounts exist; undefined pre-login. Pre-login events link via anonymousId. */
  userId?: string
  appVersion: string
  /** process.platform ('win32', …). */
  platform?: string
  /** Anonymized per-project id (random uuid), groups events by project without any name/path. */
  projectId?: string
  props?: TelemetryProps
}

/** Startup context the renderer fetches once (via IPC) and stamps onto every event it emits. */
export interface TelemetryContext {
  enabled: boolean
  sampleRates: Record<string, number>
  sessionId: string
  anonymousId: string
  userId?: string
  appVersion: string
  platform: string
}

/** Persisted config (userData/telemetryConfig.json). */
export interface TelemetryConfig {
  enabled: boolean
  sampleRates?: Record<string, number>
}

const categoryEnum = z.enum(['session', 'physical', 'command', 'tool', 'io', 'error', 'perf'])
const primitive = z.union([z.string(), z.number(), z.boolean(), z.null()])

/**
 * Runtime validator applied at the main-process IPC boundary (ipcRenderer.send is untyped).
 * Validates SHAPE, not a name whitelist: any well-formed dotted `name` is accepted so that new
 * events (e.g. a freshly added store action → `io.<action>`) are auto-captured, never dropped.
 * The taxonomy (taxonomy.ts) is the BUILD-TIME guardrail + documentation, not a runtime gate.
 */
export const telemetryEventSchema = z.object({
  v: z.number().int().nonnegative(),
  id: z.string().min(1).max(64),
  // Dotted id: a lowercase-initial namespace + one or more segments. Segments allow camelCase so
  // auto-captured store actions map cleanly (e.g. 'io.saveProject'); commands/tools stay snake_case.
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/, 'name must be a dotted id'),
  category: categoryEnum,
  ts: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(64),
  anonymousId: z.string().min(1).max(64),
  userId: z.string().max(64).optional(),
  appVersion: z.string().max(32),
  platform: z.string().max(32).optional(),
  projectId: z.string().max(64).optional(),
  props: z.record(z.string(), primitive).optional()
})

// Keep the zod schema and the hand-written type in lockstep (fails typecheck if they drift).
type _SchemaInput = z.input<typeof telemetryEventSchema>
const _lockstep = (e: TelemetryEvent): _SchemaInput => e
void _lockstep
