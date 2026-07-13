// SPDX-License-Identifier: GPL-3.0-or-later
// Import media from local paths OR http(s) URLs (e.g. a clip a Higgsfield agent just generated).
// URLs are downloaded into userData/imported first, then run through the normal import pipeline.
// Kept separate from importer.ts so that module stays Electron-free and node-testable.

import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { promisify } from 'node:util'
import { clipTypeForExtension } from '../../core'
import type { ImportedAsset } from '../../shared/ipc'
import { importMedia } from './importer'

const execFileAsync = promisify(execFile)

/** Video platforms that serve a page (not a direct media file) → route through yt-dlp instead of fetch. */
const YTDLP_HOSTS =
  /(?:^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|vimeo\.com|twitter\.com|x\.com|facebook\.com|fb\.watch|twitch\.tv|dailymotion\.com|drive\.google\.com)$/i

function needsYtDlp(url: string): boolean {
  try {
    return YTDLP_HOSTS.test(new URL(url).hostname)
  } catch {
    return false
  }
}

/** Download a platform URL (YouTube/IG/TikTok/…) with yt-dlp, remuxed to mp4 so the importer accepts it.
 *  Requires `yt-dlp` on PATH (or REELO_YTDLP); fails with a clear message if it's missing. */
async function downloadWithYtDlp(url: string): Promise<string> {
  const dir = join(app.getPath('userData'), 'imported')
  await fs.mkdir(dir, { recursive: true })
  const id = randomUUID()
  const bin = process.env.REELO_YTDLP || 'yt-dlp'
  try {
    await execFileAsync(
      bin,
      ['--no-playlist', '--merge-output-format', 'mp4', '-o', join(dir, `${id}.%(ext)s`), url],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    )
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code === 'ENOENT') {
      throw new Error(
        `Para descargar de ${new URL(url).hostname} hace falta yt-dlp. Instalalo (https://github.com/yt-dlp/yt-dlp) o pasá un enlace directo al archivo de video.`
      )
    }
    throw new Error(`yt-dlp falló para ${url}: ${err.message}`)
  }
  const produced = (await fs.readdir(dir)).filter((f) => f.startsWith(`${id}.`))
  if (produced.length === 0) throw new Error(`yt-dlp no produjo un archivo para ${url}`)
  return join(dir, produced[0])
}

function extFor(url: string, contentType: string | null): string {
  const fromPath = extname(new URL(url).pathname)
  if (fromPath) return fromPath
  const ct = contentType ?? ''
  if (ct.includes('mp4')) return '.mp4'
  if (ct.includes('quicktime')) return '.mov'
  if (ct.includes('webm')) return '.webm'
  if (ct.includes('png')) return '.png'
  if (ct.includes('jpeg')) return '.jpg'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('mpeg') || ct.includes('mp3')) return '.mp3'
  if (ct.includes('wav')) return '.wav'
  return '.bin'
}

async function downloadToFile(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`)
  const dir = join(app.getPath('userData'), 'imported')
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, `${randomUUID()}${extFor(url, res.headers.get('content-type'))}`)
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()))
  return file
}

/** Expand one source to local file paths: download an http(s) URL, list a directory's supported
 *  media files (non-recursive, sorted), or pass a file path through unchanged. */
async function resolveSource(s: string): Promise<string[]> {
  if (/^https?:\/\//i.test(s)) return [needsYtDlp(s) ? await downloadWithYtDlp(s) : await downloadToFile(s)]
  const stat = await fs.stat(s).catch(() => null)
  if (stat?.isDirectory()) {
    const names = await fs.readdir(s)
    return names
      .map((n) => join(s, n))
      .filter((p) => clipTypeForExtension(extname(p).replace(/^\./, '')) !== null)
      .sort()
  }
  return [s]
}

/** Resolve every source (URL download, folder expansion, or file path) to local paths, then
 *  import them all. A folder path imports every supported media file inside it. */
export async function importMediaFromSources(sources: string[]): Promise<ImportedAsset[]> {
  const paths: string[] = []
  for (const s of sources) paths.push(...(await resolveSource(s)))
  return importMedia(paths)
}
