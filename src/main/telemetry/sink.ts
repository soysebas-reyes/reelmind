// SPDX-License-Identifier: GPL-3.0-or-later
// TelemetrySink — the future-proofing seam. v1 wires only JsonlSink (local). Later a SupabaseSink
// (not built yet) tails the same JSONL log via an outbox cursor and uploads through main-process
// fetch (no CSP), so adding cloud sync requires NO renderer/preload/IPC change:
//   const sink = accountsEnabled ? new CompositeSink([new JsonlSink(dir), new SupabaseSink(...)]) : new JsonlSink(dir)

import type { TelemetryEvent } from '@core'

export interface TelemetrySink {
  /** Durably record events (JsonlSink writes; a network sink would enqueue). Must not throw. */
  append(events: TelemetryEvent[]): Promise<void>
  /** Force pending work out (buffer → disk / outbox → network). */
  flush(): Promise<void>
  /** Final flush + release resources. Called on before-quit. */
  close(): Promise<void>
}

/** Fan out to several sinks; a failing sink never breaks the others (local write must survive a dead network). */
export class CompositeSink implements TelemetrySink {
  constructor(private readonly sinks: TelemetrySink[]) {}
  async append(events: TelemetryEvent[]): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.append(events)))
  }
  async flush(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.flush()))
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.sinks.map((s) => s.close()))
  }
}
