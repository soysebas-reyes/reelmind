// SPDX-License-Identifier: GPL-3.0-or-later
// Generic right-click context menu overlay. The timeline is a single canvas, so menus are DOM
// overlays positioned from canvas hit-testing. One instance at a time, closed on click-outside,
// Escape, wheel, or window blur. Submenus open on hover to the side (flipping when near the edge).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuEntry {
  label: string
  /** Hint shown right-aligned, e.g. "Ctrl+C". */
  shortcut?: string
  danger?: boolean
  disabled?: boolean
  /** Shows a leading check, for toggles (Silenciar/Ocultar/…). */
  checked?: boolean
  submenu?: MenuEntry[]
  onClick?: () => void
}

export type MenuItem = MenuEntry | 'separator'

interface ContextMenuProps {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [openSub, setOpenSub] = useState<number | null>(null)
  const [subLeft, setSubLeft] = useState(false)

  // Clamp to the viewport once the menu has a measurable size.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
    setSubLeft(x + r.width + 180 > window.innerWidth)
  }, [x, y])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    const onBlur = (): void => onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  const runEntry = (entry: MenuEntry): void => {
    if (entry.disabled || !entry.onClick) return
    onClose()
    entry.onClick()
  }

  const renderEntries = (entries: MenuItem[], sub: boolean): React.JSX.Element[] =>
    entries.map((item, i) => {
      if (item === 'separator') return <div key={`sep-${i}`} className="ctx-sep" />
      const hasSub = !!item.submenu?.length
      return (
        <div
          key={item.label}
          className={`ctx-item${item.disabled ? ' disabled' : ''}${item.danger ? ' danger' : ''}`}
          onPointerEnter={() => {
            if (!sub) setOpenSub(hasSub ? i : null)
          }}
          onClick={() => {
            if (!hasSub) runEntry(item)
          }}
        >
          <span className="ctx-check">{item.checked ? '✓' : ''}</span>
          <span className="ctx-label">{item.label}</span>
          {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
          {hasSub && <span className="ctx-arrow">▸</span>}
          {hasSub && !sub && openSub === i && (
            <div className={`ctx-menu ctx-submenu${subLeft ? ' left' : ''}`}>{renderEntries(item.submenu!, true)}</div>
          )}
        </div>
      )
    })

  return (
    <>
      <div className="ctx-backdrop" onPointerDown={onClose} onWheel={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        ref={menuRef}
        className="ctx-menu"
        style={{ left: pos.left, top: pos.top }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {renderEntries(items, false)}
      </div>
    </>
  )
}
