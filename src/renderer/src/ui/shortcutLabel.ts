// SPDX-License-Identifier: GPL-3.0-or-later
// Platform-aware shortcut LABELS for menus/tooltips. The handlers already listen to ctrlKey||metaKey
// on both platforms — this only changes what the UI prints (⌘X on macOS, Ctrl+X elsewhere).

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)

/** "⌘X" on macOS, "Ctrl+X" elsewhere. */
export function mod(key: string): string {
  return isMac ? `⌘${key}` : `Ctrl+${key}`
}

/** Delete-key label: "⌫" on macOS, "Supr" elsewhere (Spanish UI). */
export function delKey(): string {
  return isMac ? '⌫' : 'Supr'
}
