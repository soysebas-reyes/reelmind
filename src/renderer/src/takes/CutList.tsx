// SPDX-License-Identifier: GPL-3.0-or-later
// Per-take review of the AI's clean cuts (fillers / silences / repeats / false starts). Each cut has a
// checkbox (default ON) so the user vetoes any cut before the tabs are built — applyTakesPlan only
// applies the accepted ones (see acceptedCutsForTake). The `cutAccepted` state is index-aligned with the
// WHOLE plan.cuts array, so we keep each cut's GLOBAL index (`gi`) to toggle the right flag.

import { useEditorStore } from '../store'
import { mmss } from './format'

/** kind → short Spanish label + a `.pill` tone (reusing the existing pill palette). */
const KIND_META: Record<string, { label: string; cls: string }> = {
  muletilla: { label: 'muletilla', cls: 'warn' },
  silencio: { label: 'silencio', cls: '' },
  repeticion: { label: 'repetición', cls: 'ok' },
  'falso-inicio': { label: 'falso inicio', cls: 'err' }
}

export function CutList({ takeIndex }: { takeIndex: number }): React.JSX.Element | null {
  const plan = useEditorStore((s) => s.takesPlan)
  const setCutAccepted = useEditorStore((s) => s.setCutAccepted)
  if (!plan) return null

  // Keep the GLOBAL index so the checkbox toggles the correct cutAccepted slot.
  const items = plan.cuts.map((cut, gi) => ({ cut, gi })).filter(({ cut }) => cut.takeIndex === takeIndex)
  if (items.length === 0) return null

  const active = items.filter(({ gi }) => plan.cutAccepted[gi]).length
  const setAll = (accepted: boolean): void => {
    for (const { gi } of items) setCutAccepted(gi, accepted)
  }

  return (
    <div className="cutlist">
      <div className="cutlist-head">
        <span className="cutlist-title">
          Cortes ({items.length} · {active} activos)
        </span>
        <span className="cutlist-actions">
          <button type="button" data-tel="takes.cuts_accept_all" onClick={() => setAll(true)}>
            Aceptar todos
          </button>
          <button type="button" data-tel="takes.cuts_reject_all" onClick={() => setAll(false)}>
            Rechazar todos
          </button>
        </span>
      </div>
      <ul className="cutlist-items">
        {items.map(({ cut, gi }) => {
          const meta = KIND_META[cut.kind] ?? { label: cut.kind, cls: '' }
          const accepted = plan.cutAccepted[gi]
          const secs = ((cut.endMs - cut.startMs) / 1000).toFixed(1)
          const label = cut.kind === 'silencio' ? `(${secs} s)` : cut.text ? `«${cut.text}»` : ''
          return (
            <li key={gi} className={`cutlist-item${accepted ? '' : ' rejected'}`}>
              <label>
                <input
                  type="checkbox"
                  data-tel="takes.cut_toggle"
                  checked={accepted}
                  onChange={(e) => setCutAccepted(gi, e.target.checked)}
                />
                <span className={`pill ${meta.cls}`}>{meta.label}</span>
                <span className="cutlist-text" title={cut.reason || meta.label}>
                  {label}
                </span>
                <span className="cutlist-time">{mmss(cut.startMs)}</span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
