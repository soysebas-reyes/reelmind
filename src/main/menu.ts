// SPDX-License-Identifier: GPL-3.0-or-later
// macOS application menu (role-based). Without an explicit menu, mac users get Electron's default
// dev-branded menu and — worse — no working ⌘C/⌘V/⌘Z inside text inputs, because those arrive via
// the Edit menu's roles on macOS. Windows/Linux keep their current (default) menu behavior.

import { Menu } from 'electron'

export function installAppMenu(): void {
  if (process.platform !== 'darwin') return
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' }, // About / Hide / Quit — takes the app name (Reelo) from the bundle
      { role: 'editMenu' }, // undo/redo/cut/copy/paste/selectAll for inputs
      { role: 'viewMenu' }, // reload/devtools/zoom — useful while the mac build is young
      { role: 'windowMenu' }
    ])
  )
}
