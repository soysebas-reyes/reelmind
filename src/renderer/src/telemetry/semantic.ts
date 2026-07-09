// SPDX-License-Identifier: GPL-3.0-or-later
// SEMANTIC-EDIT capture (Pilar II): every committed EditorController command flows through the
// IoC commit hook (setCommitObserver in @core), so any command added in the future is measured
// automatically with its origin (user/agent). The display label is normalized to a stable id
// (unknown → command.other, never unmeasured). Rapid identical commits (slider gestures) coalesce.

import { normalizeCommandLabel, setCommitObserver } from '@core'
import { emit } from './client'

const COALESCE_MS = 400

export function installSemantic(): void {
  let lastKey = ''
  let lastTs = 0
  setCommitObserver((info) => {
    const id = normalizeCommandLabel(info.label)
    const key = `${id}|${info.origin}|${info.coalesceKey ?? ''}`
    const t = Date.now()
    if (key === lastKey && t - lastTs < COALESCE_MS) {
      lastTs = t
      return // same gesture within the window → one event per burst
    }
    lastKey = key
    lastTs = t
    emit('command', id, { origin: info.origin, coalesced: Boolean(info.coalesceKey) })
  })
}
