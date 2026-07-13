// Load .env before anything else — electron-vite does NOT inject non-VITE_ vars into main.
import 'dotenv/config'
import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_NAME, editorToolsByName } from '@core'
import { registerIpc } from './ipc'
import { installAppMenu } from './menu'
import { initUpdates } from './updates'
import { initTelemetry } from './telemetry'
import { handleMediaProtocol, registerMediaScheme } from './media/mediaProtocol'
import { executeToolInRenderer } from './mcp/bridge'
import { createMcpHttpServer } from './mcp/server'

const isDev = !app.isPackaged
const MCP_PORT = Number(process.env.REELO_MCP_PORT) || 4399

// Must run before app 'ready'.
registerMediaScheme()

/** In a packaged build, point the ffmpeg layer at the bundled binaries (env still wins). */
function configureBundledFfmpeg(): void {
  if (!app.isPackaged) return
  const dir = join(process.resourcesPath, 'ffmpeg')
  const ext = process.platform === 'win32' ? '.exe' : ''
  const ffmpeg = join(dir, `ffmpeg${ext}`)
  const ffprobe = join(dir, `ffprobe${ext}`)
  if (!process.env.REELO_FFMPEG && existsSync(ffmpeg)) process.env.REELO_FFMPEG = ffmpeg
  if (!process.env.REELO_FFPROBE && existsSync(ffprobe)) process.env.REELO_FFPROBE = ffprobe
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: '#15151a',
    title: APP_NAME,
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
    console.error(`[reelo] renderer gone: ${details.reason} (exit ${details.exitCode})`)
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
  installAppMenu()
  configureBundledFfmpeg()
  handleMediaProtocol()
  registerIpc()
  initUpdates()
  initTelemetry() // behavioral measurement sink — see docs/TOTAL_MEASUREMENT_PLAN.md
  createWindow()

  app.on('child-process-gone', (_e, details) => {
    console.error(`[reelo] child gone: ${details.type} — ${details.reason}`)
  })

  // Embedded MCP server (localhost) so external agents drive the same editor commands.
  // Per-tool timeout overrides (export/transcribe/…) come from the tool contract itself.
  if (!process.env.REELO_NO_MCP) {
    createMcpHttpServer({
      port: MCP_PORT,
      version: app.getVersion(),
      execute: (name, input) => executeToolInRenderer(name, input, editorToolsByName.get(name)?.timeoutMs ?? 300_000)
    })
      .then((h) => console.log(`[reelo] MCP server listening at ${h.url}`))
      .catch((e) => console.error('[reelo] MCP server failed to start:', e))
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
