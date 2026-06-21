// SPDX-License-Identifier: GPL-3.0-or-later
// Registers all ipcMain handlers backing the preload `editorBridge`.

import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { AiCompleteRequest, DetectSilencesRequest, ExportRequest, ProjectData, ThumbnailRequest } from '../shared/ipc'
import { complete } from './ai/anthropic'
import { clearApiKey, hasApiKey, setApiKey } from './ai/secrets'
import { checkFfmpeg, generateThumbnail } from './ffmpeg'
import { exportTimeline } from './ffmpeg/exporter'
import { detectSilences } from './ffmpeg/silence'
import { importMedia } from './media/importer'
import { importMediaFromSources } from './media/importSources'
import { loadProject, saveProject } from './project/projectStore'

const MEDIA_EXTENSIONS = [
  'mov',
  'mp4',
  'm4v',
  'mp3',
  'wav',
  'aac',
  'm4a',
  'png',
  'jpg',
  'jpeg',
  'tiff',
  'heic',
  'webp',
  'json',
  'lottie'
]

function focused(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? undefined
}

export function registerIpc(): void {
  ipcMain.handle('app:ping', () => ({
    ok: true,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }))

  ipcMain.handle('ffmpeg:check', () => checkFfmpeg())

  ipcMain.handle('media:pick', async () => {
    const win = focused()
    const res = await (win
      ? dialog.showOpenDialog(win, dialogOpts())
      : dialog.showOpenDialog(dialogOpts()))
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle('media:import', (_e, paths: string[]) => importMedia(paths))

  ipcMain.handle('media:importSources', (_e, sources: string[]) => importMediaFromSources(sources))

  ipcMain.handle('media:thumbnails', async (_e, items: ThumbnailRequest[]) => {
    const results = []
    for (const it of items) {
      results.push({
        id: it.id,
        thumbnail: await generateThumbnail(it.path, { type: it.type, durationSeconds: it.durationSeconds })
      })
    }
    return results
  })

  ipcMain.handle('project:pickSavePath', async (_e, defaultName: string) => {
    const win = focused()
    const opts = { defaultPath: `${defaultName || 'Untitled'}.vproj` }
    const res = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    return res.canceled || !res.filePath ? null : res.filePath
  })

  ipcMain.handle('project:pickOpenDir', async () => {
    const win = focused()
    const opts = { properties: ['openDirectory' as const] }
    const res = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts))
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle('project:save', async (_e, dir: string, data: ProjectData) => {
    try {
      await saveProject(dir, data)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('project:load', (_e, dir: string) => loadProject(dir))

  ipcMain.handle('project:pickExportPath', async (_e, defaultName: string) => {
    const win = focused()
    const opts = {
      defaultPath: `${defaultName || 'Untitled'}.mp4`,
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    }
    const res = await (win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    return res.canceled || !res.filePath ? null : res.filePath
  })

  ipcMain.handle('project:export', (_e, req: ExportRequest) => exportTimeline(req))

  ipcMain.handle('media:detectSilences', (_e, req: DetectSilencesRequest) =>
    detectSilences(req.path, { noiseDb: req.noiseDb, minDurationSec: req.minDurationSec })
  )

  ipcMain.handle('ai:hasKey', () => hasApiKey())
  ipcMain.handle('ai:setKey', (_e, key: string) => setApiKey(key))
  ipcMain.handle('ai:clearKey', () => clearApiKey())
  ipcMain.handle('ai:complete', (_e, req: AiCompleteRequest) => complete(req))
}

function dialogOpts() {
  return {
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: [{ name: 'Media', extensions: MEDIA_EXTENSIONS }]
  }
}
