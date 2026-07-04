// SPDX-License-Identifier: GPL-3.0-or-later
// Project tab bar. Each tab is a Session (its own timeline/undo/manifest); the store mirrors the
// active one. Shown only when more than one project is open (e.g. after "Segmentar por guiones").

import { useEditorStore } from '../store'

export function SessionTabs(): React.JSX.Element | null {
  const tabs = useEditorStore((s) => s.tabs)
  const activeTabId = useEditorStore((s) => s.activeTabId)
  const switchSession = useEditorStore((s) => s.switchSession)
  const closeSession = useEditorStore((s) => s.closeSession)
  if (tabs.length <= 1) return null

  return (
    <div
      className="session-tabs"
      style={{
        display: 'flex',
        gap: 4,
        padding: '4px 8px',
        overflowX: 'auto',
        borderBottom: '1px solid var(--hairline, #2a2a30)',
        background: 'var(--panel, #1b1b21)'
      }}
    >
      {tabs.map((t) => {
        const active = t.id === activeTabId
        return (
          <div
            key={t.id}
            onClick={() => switchSession(t.id)}
            title={t.name}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              maxWidth: 220,
              padding: '4px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 12,
              whiteSpace: 'nowrap',
              background: active ? 'var(--accent, #0a84ff)' : 'transparent',
              color: active ? '#fff' : 'var(--text, #e8e8ea)',
              border: `1px solid ${active ? 'transparent' : 'var(--hairline, #2a2a30)'}`
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {t.name}
              {t.dirty ? ' •' : ''}
            </span>
            <button
              title="Cerrar pestaña"
              onClick={(e) => {
                e.stopPropagation()
                if (t.dirty && !window.confirm(`Cerrar "${t.name}"? Hay cambios sin guardar.`)) return
                closeSession(t.id)
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                padding: 0,
                lineHeight: 1,
                opacity: 0.7,
                fontSize: 14
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
