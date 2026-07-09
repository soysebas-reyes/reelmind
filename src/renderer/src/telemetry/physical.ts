// SPDX-License-Identifier: GPL-3.0-or-later
// PHYSICAL capture layer (Pilar I of the always-valid doctrine): feature-agnostic window listeners
// in the CAPTURE phase (same pattern as main.tsx's drag/drop guards). Records clicks, sampled
// pointer movement, keys (never typed text), wheel, and panel dwell for ANY element that renders —
// no per-feature code. Listeners are passive + try/catch-wrapped: a telemetry bug can never break
// editing, and we never preventDefault/stopPropagation, so existing handlers are untouched.

import { emit } from './client'
import { onActivity, onPanel, onVisibility } from './dwell'

const PANELS = ['timeline', 'bin', 'stage', 'right-panel', 'toolbar', 'session-tabs', 'statusbar', 'workspace']
const PANEL_SELECTOR = PANELS.map((c) => `.${c}`).join(',')

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function panelOf(el: Element | null): string | null {
  const p = el?.closest?.(PANEL_SELECTOR) as HTMLElement | null
  if (!p) return null
  for (const c of PANELS) if (p.classList.contains(c)) return c
  return null
}

/** A non-identifying descriptor of the click target: a `data-tel` id, else {tag, role}, + panel. */
function describeTarget(el: Element | null): Record<string, unknown> {
  const node = el as HTMLElement | null
  const info: Record<string, unknown> = { panel: panelOf(node) }
  const tel = node?.closest?.('[data-tel]') as HTMLElement | null
  if (tel?.dataset?.tel) {
    info.tel = tel.dataset.tel
  } else if (node) {
    info.tag = node.tagName?.toLowerCase()
    const role = node.getAttribute?.('role')
    if (role) info.role = role
  }
  return info
}

function isTextField(el: Element | null): boolean {
  const n = el as HTMLElement | null
  if (!n) return false
  return n.matches?.('input, textarea') === true || n.isContentEditable === true
}

function bucket(n: number): number {
  if (n <= 1) return 1
  if (n <= 5) return 5
  if (n <= 10) return 10
  if (n <= 25) return 25
  if (n <= 50) return 50
  return 100
}

// ── Pointer: accumulate O(1), sample on a single rAF loop (no per-move IPC/emit) ────────────────
let ptrX = 0
let ptrY = 0
let hasMove = false
let buttons = 0
let lastSampleTs = 0

function onPointerMove(e: PointerEvent): void {
  ptrX = e.clientX
  ptrY = e.clientY
  buttons = e.buttons
  hasMove = true
}

function sampleTick(ts: number): void {
  requestAnimationFrame(sampleTick)
  const interval = buttons !== 0 ? 100 : 500 // drags are the high-value signal → sample faster
  if (!hasMove || ts - lastSampleTs < interval) return
  lastSampleTs = ts
  hasMove = false
  try {
    const el = document.elementFromPoint(ptrX, ptrY)
    const panel = panelOf(el)
    emit('physical', 'physical.pointer', {
      x: round3(ptrX / window.innerWidth),
      y: round3(ptrY / window.innerHeight),
      dragging: buttons !== 0,
      buttons,
      panel
    })
    onActivity()
    onPanel(panel)
  } catch {
    // ignore
  }
}

// ── Keyboard privacy gate: never capture typed characters in text fields ────────────────────────
let typingCount = 0
let typingField: Record<string, unknown> | null = null
let typingTimer: ReturnType<typeof setTimeout> | null = null

function flushTyping(): void {
  if (typingCount === 0) return
  emit('physical', 'physical.key', {
    typing: true,
    inField: true,
    key: null,
    chars: bucket(typingCount),
    ...(typingField ?? {})
  })
  typingCount = 0
  typingField = null
  typingTimer = null
}

function onKeydown(e: KeyboardEvent): void {
  onActivity()
  const el = e.target as Element | null
  const cmdMod = e.ctrlKey || e.metaKey || e.altKey // shift is NOT a command modifier
  if (isTextField(el) && !cmdMod) {
    // Composing text: record ONLY a bucketed keystroke count, never the characters.
    typingCount += 1
    typingField = describeTarget(el)
    if (typingTimer) clearTimeout(typingTimer)
    typingTimer = setTimeout(flushTyping, 1000)
    return
  }
  emit('physical', 'physical.key', {
    key: e.key.length <= 16 ? e.key : 'long',
    code: e.code,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    repeat: e.repeat,
    inField: isTextField(el),
    panel: panelOf(el)
  })
}

function onClick(e: MouseEvent): void {
  onActivity()
  const el = e.target as Element | null
  onPanel(panelOf(el))
  emit('physical', 'physical.click', {
    x: round3(e.clientX / window.innerWidth),
    y: round3(e.clientY / window.innerHeight),
    button: e.button,
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    shift: e.shiftKey,
    alt: e.altKey,
    ...describeTarget(el)
  })
}

function onContextMenu(e: MouseEvent): void {
  onActivity()
  emit('physical', 'physical.click', {
    x: round3(e.clientX / window.innerWidth),
    y: round3(e.clientY / window.innerHeight),
    button: 2,
    context: true,
    ...describeTarget(e.target as Element)
  })
}

let lastWheel = 0
function onWheel(e: WheelEvent): void {
  onActivity()
  const now = Date.now()
  if (now - lastWheel < 200) return
  lastWheel = now
  emit('physical', 'physical.wheel', { panel: panelOf(e.target as Element), dy: Math.sign(e.deltaY), ctrl: e.ctrlKey })
}

function onFocusIn(e: FocusEvent): void {
  onActivity()
  onPanel(panelOf(e.target as Element))
}

function onVisibilityChange(): void {
  const vis = document.visibilityState === 'visible'
  onVisibility(vis)
  emit('session', 'session.visibility', { visible: vis })
}

export function installPhysical(): void {
  const opts: AddEventListenerOptions = { capture: true, passive: true }
  window.addEventListener('click', onClick, opts)
  window.addEventListener('contextmenu', onContextMenu, opts)
  window.addEventListener('pointermove', onPointerMove, opts)
  window.addEventListener('pointerdown', (e) => {
    buttons = (e as PointerEvent).buttons
    onActivity()
  }, opts)
  window.addEventListener('pointerup', () => {
    buttons = 0
  }, opts)
  window.addEventListener('wheel', onWheel, opts)
  window.addEventListener('keydown', onKeydown, opts)
  window.addEventListener('focusin', onFocusIn, opts)
  document.addEventListener('visibilitychange', onVisibilityChange)
  requestAnimationFrame(sampleTick)
}
