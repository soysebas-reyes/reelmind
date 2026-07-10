// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-update wiring (electron-updater + GitHub Releases). Normalizes updater events into a single
// `update:status` broadcast so the renderer (Ajustes → Acerca de) shows one coherent state line, and
// exposes a manual check + install. The passive startup check keeps the old notify behavior.

import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatusEvent } from '../shared/ipc'

function broadcast(ev: UpdateStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:status', ev)
  }
}

export function initUpdates(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('update:check', (): UpdateStatusEvent => {
    if (!app.isPackaged) return { status: 'dev' }
    // Not awaited: the updater events drive the UI from here on.
    autoUpdater.checkForUpdates().catch((e) => {
      broadcast({ status: 'error', error: e instanceof Error ? e.message : String(e) })
    })
    return { status: 'checking' }
  })

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  autoUpdater.on('checking-for-update', () => broadcast({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => broadcast({ status: 'available', version: info.version }))
  autoUpdater.on('download-progress', (p) => broadcast({ status: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-not-available', () => broadcast({ status: 'none', version: app.getVersion() }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ status: 'downloaded', version: info.version }))
  autoUpdater.on('error', (e) => broadcast({ status: 'error', error: e.message }))

  // Passive startup check (packaged only) — same singleton, its events flow through the broadcast too.
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[reelmind] update check failed:', e))
  }
}
