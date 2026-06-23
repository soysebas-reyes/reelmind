import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { registerIpc } from './ipc'
import { handleMediaProtocol, registerMediaScheme } from './media/mediaProtocol'
import { executeToolInRenderer } from './mcp/bridge'
import { createMcpHttpServer } from './mcp/server'

const isDev = !app.isPackaged
const MCP_PORT = Number(process.env.REELMIND_MCP_PORT) || 4399

// Must run before app 'ready'.
registerMediaScheme()

/** In a packaged build, point the ffmpeg layer at the bundled binaries (env still wins). */
function configureBundledFfmpeg(): void {
  if (!app.isPackaged) return
  const dir = join(process.resourcesPath, 'ffmpeg')
  const ffmpeg = join(dir, 'ffmpeg.exe')
  const ffprobe = join(dir, 'ffprobe.exe')
  if (!process.env.REELMIND_FFMPEG && existsSync(ffmpeg)) process.env.REELMIND_FFMPEG = ffmpeg
  if (!process.env.REELMIND_FFPROBE && existsSync(ffprobe)) process.env.REELMIND_FFPROBE = ffprobe
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#15151a',
    title: 'ReelMind',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // Observability: renderer logs + process/GPU crashes don't otherwise reach this terminal. A React
  // render error blanks the window WITHOUT killing the process, so console-message is what surfaces it.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[reelmind] renderer gone: ${details.reason} (exit ${details.exitCode})`)
  })
  if (isDev) {
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error' || details.level === 'warning') {
        console.log(`[renderer:${details.level}] ${details.message}`)
      }
    })
  }

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  configureBundledFfmpeg()
  handleMediaProtocol()
  registerIpc()
  createWindow()

  app.on('child-process-gone', (_e, details) => {
    console.error(`[reelmind] child gone: ${details.type} — ${details.reason}`)
  })

  // Embedded MCP server (localhost) so external agents drive the same editor commands.
  if (!process.env.REELMIND_NO_MCP) {
    createMcpHttpServer({ port: MCP_PORT, execute: executeToolInRenderer })
      .then((h) => console.log(`[reelmind] MCP server listening at ${h.url}`))
      .catch((e) => console.error('[reelmind] MCP server failed to start:', e))
  }

  // Auto-update from GitHub Releases (packaged builds only).
  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[reelmind] update check failed:', e))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
