// SPDX-License-Identifier: GPL-3.0-or-later
// Registers all ipcMain handlers backing the preload `editorBridge`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { parseCubeLut } from '../core'
import type {
  AiCompleteRequest,
  AudioOffsetRequest,
  AudioPreviewRequest,
  ColorLutDataRequest,
  ColorStillRequest,
  DetectSilencesRequest,
  EnhanceAudioRequest,
  ExportRequest,
  ExtractAudioRequest,
  GenerateProxyRequest,
  IsolateVoiceRequest,
  PreviewIsolateRequest,
  ProjectData,
  ThumbnailRequest,
  TranscribeRequest
} from '../shared/ipc'
import { readFile, rm } from 'node:fs/promises'
import { complete } from './ai/anthropic'
import { transcribeMedia } from './elevenlabs/transcript'
import { isolateVoice, isolateVoiceSnippet } from './elevenlabs/voiceIsolation'
import { clearApiKey, hasApiKey, setApiKey } from './ai/secrets'
import { getLutLibraryDir, profileLutDir, setLutLibraryDir } from './color/colorSettings'
import { resolveLut } from './color/lutResolver'
import {
  analyzeIntensity,
  checkFfmpeg,
  computeAudioOffset,
  enhanceAudio,
  enhanceAudioPreview,
  extractAudio,
  generateProxy,
  generateStillWithColor,
  generateThumbnail
} from './ffmpeg'
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

  ipcMain.handle('project:export', (e, req: ExportRequest) => {
    // Quality tier → x264 CRF (lower = larger/closer to source). Default 'veryHigh' so a graded export
    // lands near the source size instead of the older CRF-18 default that looked "too small".
    const crf = req.quality === 'max' ? 12 : req.quality === 'high' ? 20 : 16
    return exportTimeline(
      { ...req, options: { crf } },
      {
        onProgress: (fraction) => e.sender.send('export:progress', fraction),
        resolveLut: (lutRef) =>
          resolveLut(lutRef, { projectDir: req.projectDir, libraryDir: getLutLibraryDir(), profileDir: profileLutDir() })
      }
    )
  })

  // Reveal a finished export in the OS file manager (the export confirmation's "show in folder").
  ipcMain.handle('shell:showItem', (_e, filePath: string) => {
    if (filePath) shell.showItemInFolder(filePath)
  })

  ipcMain.handle('media:detectSilences', (e, req: DetectSilencesRequest) =>
    detectSilences(req.path, {
      noiseDb: req.noiseDb,
      minDurationSec: req.minDurationSec,
      onLine: (line) => e.sender.send('op:progress', { stage: 'silences', line })
    })
  )

  // Multicam (audio): extract a video's audio to a new file, and cross-correlate two videos' audio.
  ipcMain.handle('media:extractAudio', async (_e, req: ExtractAudioRequest) => {
    try {
      const outDir = req.outDir ?? join(app.getPath('userData'), 'imported')
      return { ok: true, outputPath: await extractAudio(req.videoPath, outDir) }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  ipcMain.handle('media:enhanceAudio', async (e, req: EnhanceAudioRequest) => {
    try {
      const outDir = req.outDir ?? join(app.getPath('userData'), 'imported')
      const { srcPath: _src, outDir: _out, ...settings } = req
      const outputPath = await enhanceAudio(req.srcPath, outDir, {
        ...settings,
        onLine: (line) => e.sender.send('op:progress', { stage: 'enhance', line })
      })
      return { ok: true, outputPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // Short raw + enhanced snippets for the A/B player in the audio modal (returned as data URLs).
  ipcMain.handle('media:enhanceAudioPreview', async (_e, req: AudioPreviewRequest) => {
    try {
      const clips = await enhanceAudioPreview(req.srcPath, {
        startSec: req.startSec,
        durationSec: req.durationSec,
        settings: req.settings
      })
      return { ok: true, ...clips }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('media:generateProxy', async (e, req: GenerateProxyRequest) => {
    try {
      const outDir = req.outDir ?? join(app.getPath('userData'), 'imported')
      const outputPath = await generateProxy(req.srcPath, outDir, {
        onLine: (line) => e.sender.send('op:progress', { stage: 'proxy', line })
      })
      return { ok: true, outputPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('media:computeAudioOffset', async (_e, req: AudioOffsetRequest) => {
    try {
      const r = await computeAudioOffset(req.pathA, req.pathB, req.fps)
      return { ok: true, offsetSeconds: r.offsetSeconds, offsetFrames: r.offsetFrames, confidence: r.confidence, reliable: r.reliable }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  // Loudness envelope + emphasis peaks for the angle-cut preview (no Python — pure FFmpeg + @core DSP).
  ipcMain.handle('media:analyzeIntensity', async (e, path: string) => {
    try {
      e.sender.send('op:progress', { stage: 'peaks', line: 'Analizando intensidad de audio (picos de sonido)…' })
      const r = await analyzeIntensity(path)
      e.sender.send('op:progress', {
        stage: 'peaks',
        line: `Detectados ${r.peaks.length} picos y ${r.pauses.length} pausas.`
      })
      return {
        ok: true,
        envelope: r.envelope,
        envelopeRate: r.envelopeRate,
        peaks: r.peaks,
        pauses: r.pauses,
        durationSec: r.durationSec
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Color (Phase 9.5): exact graded preview still + the side-loaded LUT library folder.
  ipcMain.handle('color:still', async (_e, req: ColorStillRequest) => {
    try {
      const lutPath = req.color.lutRef
        ? resolveLut(req.color.lutRef, {
            projectDir: req.projectDir,
            libraryDir: getLutLibraryDir(),
            profileDir: profileLutDir()
          })
        : null
      return await generateStillWithColor(req.mediaPath, req.seekSeconds, req.color, { width: req.width, lutPath })
    } catch {
      return null // e.g. invoked on a streamless (audio) asset — fail soft, no rejected promise
    }
  })
  // Resolve + parse a .cube into grid data the renderer's WebGL preview can sample as a 3D texture, so
  // the LUT shows during live playback (not just in the paused FFmpeg still / export). Same resolution
  // order as color:still; a missing/invalid LUT returns null and the preview renders the grade without it.
  ipcMain.handle('color:lutData', (_e, req: ColorLutDataRequest) => {
    const path = resolveLut(req.lutRef, {
      projectDir: req.projectDir,
      libraryDir: getLutLibraryDir(),
      profileDir: profileLutDir()
    })
    if (!path) return null
    try {
      const lut = parseCubeLut(readFileSync(path, 'utf8'))
      return { size: lut.size, data: Array.from(lut.data) }
    } catch {
      return null
    }
  })
  ipcMain.handle('color:getLutLibrary', () => getLutLibraryDir())
  ipcMain.handle('color:setLutLibrary', async () => {
    const win = focused()
    const props: 'openDirectory'[] = ['openDirectory']
    const res = win
      ? await dialog.showOpenDialog(win, { properties: props })
      : await dialog.showOpenDialog({ properties: props })
    if (res.canceled || !res.filePaths[0]) return getLutLibraryDir()
    setLutLibraryDir(res.filePaths[0])
    return res.filePaths[0]
  })

  // ElevenLabs Speech-to-Text: extract audio → Scribe v1 → word-level timestamps.
  ipcMain.handle('ai:transcribe', async (e, req: TranscribeRequest) => {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY not set. Add it to .env or app settings.' }
    try {
      const outDir = join(app.getPath('userData'), 'imported')
      const result = await transcribeMedia(req.mediaPath, apiKey, outDir, {
        languageCode: req.languageCode,
        diarize: req.diarize,
        onLine: (line) => e.sender.send('op:progress', { stage: 'transcribe', line })
      })
      return { ok: true, text: result.text, words: result.words }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ElevenLabs Audio Isolation: ML voice cleanup (noise/music/reverb removal) → new .m4a.
  ipcMain.handle('ai:isolateVoice', async (e, req: IsolateVoiceRequest) => {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY not set. Add it to .env or app settings.' }
    try {
      const outDir = req.outDir ?? join(app.getPath('userData'), 'imported')
      const outputPath = await isolateVoice(req.srcPath, apiKey, outDir, {
        intensity: req.intensity,
        denoise: req.denoise,
        onLine: (line) => e.sender.send('op:progress', { stage: 'isolate', line })
      })
      return { ok: true, outputPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Isolate a short WINDOW for the modal A/B preview (cheap per-click ElevenLabs call). Returns the raw +
  // isolated window as base64 data URLs; temp files are cleaned immediately (no clip is touched).
  ipcMain.handle('ai:previewIsolateVoice', async (_e, req: PreviewIsolateRequest) => {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) return { ok: false, error: 'ELEVENLABS_API_KEY not set. Add it to .env or app settings.' }
    let rawPath: string | undefined
    let isolatedPath: string | undefined
    try {
      const out = await isolateVoiceSnippet(req.srcPath, apiKey, {
        startSec: req.startSec,
        durationSec: req.durationSec,
        intensity: req.intensity,
        denoise: req.denoise
      })
      rawPath = out.rawPath
      isolatedPath = out.isolatedPath
      const rawDataUrl = `data:audio/mp4;base64,${(await readFile(rawPath)).toString('base64')}`
      const isolatedDataUrl = `data:audio/mp4;base64,${(await readFile(isolatedPath)).toString('base64')}`
      return { ok: true, rawDataUrl, isolatedDataUrl }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (rawPath) await rm(rawPath, { force: true })
      if (isolatedPath) await rm(isolatedPath, { force: true })
    }
  })

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
