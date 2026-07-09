// SPDX-License-Identifier: GPL-3.0-or-later
// IO/orchestration capture (Pilar II, store side): auto-wrap every Zustand store action ONCE at
// init so import/save/open/export/sync/transcribe/takes/angles/audio/tab/inspector actions — and
// any action added in the future — emit an `io.<action>` event with outcome + duration. Only arg
// NAMES/typeof are recorded, never values (args are often paths). High-frequency/internal actions
// are excluded to avoid floods. The tool seam (runEditorTool) is instrumented in runTool.ts.

import { useEditorStore } from '../store'
import { emit } from './client'

// Noisy/internal actions: playback ticks + progress lifecycle + pure UI-open toggles fire often
// or carry no measurement value. Everything else is auto-captured.
const IO_EXCLUDE = new Set<string>([
  'init',
  'setStep',
  'startProgress',
  'appendProgressLog',
  'finishProgress',
  'dismissProgress',
  'setPlaying'
])

/** Record arg SHAPE only (names/typeof) — never values (which may be file paths). */
function describeArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a === null || a === undefined) return 'none'
      if (Array.isArray(a)) return 'array'
      if (typeof a === 'object') return Object.keys(a as object).slice(0, 8).join('|')
      return typeof a
    })
    .join(',')
}

export function installStoreTelemetry(): void {
  useEditorStore.setState((s) => {
    const st = s as unknown as Record<string, unknown>
    const originals: Record<string, (...a: unknown[]) => unknown> = {}
    for (const k of Object.keys(st)) {
      if (IO_EXCLUDE.has(k)) continue
      if (typeof st[k] === 'function') originals[k] = st[k] as (...a: unknown[]) => unknown
    }
    for (const name of Object.keys(originals)) {
      const fn = originals[name]
      st[name] = function instrumented(this: unknown, ...args: unknown[]): unknown {
        const t0 = performance.now()
        const done = (ok: boolean): void =>
          emit('io', `io.${name}`, { name, ok, ms: Math.round(performance.now() - t0), args: describeArgs(args) })
        try {
          const r = fn.apply(this, args)
          if (r && typeof (r as { then?: unknown }).then === 'function') {
            return (r as Promise<unknown>).then(
              (v) => {
                done(true)
                return v
              },
              (e) => {
                done(false)
                throw e
              }
            )
          }
          done(true)
          return r
        } catch (e) {
          done(false)
          throw e
        }
      }
    }
  })
}
