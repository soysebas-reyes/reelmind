// SPDX-License-Identifier: GPL-3.0-or-later
// Append-only JSONL sink. Chosen over SQLite: no native-build infra in this project, O(1) append,
// crash-tolerant (a torn trailing line is dropped by readers), zero deps, and it doubles as the
// durable buffer/outbox the future Supabase syncer tails. Daily files + size sharding + retention
// bound disk. Events arrive already batched from the renderer; main coalesces further and writes
// one appendFile per flush. Final flush on quit is synchronous (before-quit can't await async I/O).

import { appendFileSync, mkdirSync } from 'node:fs'
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TelemetryEvent } from '@core'
import type { TelemetrySink } from './sink'

const FLUSH_COUNT = 50
const FLUSH_MS = 5000
const HWM = 10_000
const SHARD_BYTES = 32 * 1024 * 1024
const RETENTION_DAYS = 30

export class JsonlSink implements TelemetrySink {
  private queue: TelemetryEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false

  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* non-fatal */
    }
    void this.pruneOld()
  }

  async append(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return
    this.queue.push(...events)
    if (this.queue.length > HWM) {
      this.queue.splice(0, this.queue.length - HWM) // drop OLDEST under back-pressure
    }
    if (!this.timer) this.timer = setInterval(() => void this.flush(), FLUSH_MS)
    if (this.queue.length >= FLUSH_COUNT) await this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue
    this.queue = []
    try {
      const block = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
      await mkdir(this.dir, { recursive: true })
      await appendFile(await this.targetPath(), block, 'utf8')
    } catch {
      this.queue.unshift(...batch) // retry on next flush (best-effort)
    } finally {
      this.flushing = false
    }
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.queue.length === 0) return
    const batch = this.queue
    this.queue = []
    try {
      const block = batch.map((e) => JSON.stringify(e)).join('\n') + '\n'
      appendFileSync(this.todayBase(), block, 'utf8') // sync: before-quit cannot await
    } catch {
      /* best-effort */
    }
  }

  private todayBase(): string {
    const day = new Date().toISOString().slice(0, 10)
    return join(this.dir, `events-${day}.jsonl`)
  }

  /** Today's file, rolling to `.N.jsonl` shards once one exceeds SHARD_BYTES. */
  private async targetPath(): Promise<string> {
    const base = this.todayBase()
    try {
      for (let n = 0; ; n++) {
        const candidate = n === 0 ? base : base.replace(/\.jsonl$/, `.${n}.jsonl`)
        let size = 0
        try {
          size = (await stat(candidate)).size
        } catch {
          return candidate // does not exist yet → use it
        }
        if (size < SHARD_BYTES) return candidate
      }
    } catch {
      return base
    }
  }

  private async pruneOld(): Promise<void> {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
      for (const f of await readdir(this.dir)) {
        if (!/^events-\d{4}-\d{2}-\d{2}(\.\d+)?\.jsonl$/.test(f)) continue
        const full = join(this.dir, f)
        if ((await stat(full)).mtimeMs < cutoff) await rm(full, { force: true })
      }
    } catch {
      /* non-fatal */
    }
  }
}
