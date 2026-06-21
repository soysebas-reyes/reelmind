// SPDX-License-Identifier: GPL-3.0-or-later
// Import media from local paths OR http(s) URLs (e.g. a clip a Higgsfield agent just generated).
// URLs are downloaded into userData/imported first, then run through the normal import pipeline.
// Kept separate from importer.ts so that module stays Electron-free and node-testable.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { extname, join } from 'node:path'
import { clipTypeForExtension } from '../../core'
import type { ImportedAsset } from '../../shared/ipc'
import { importMedia } from './importer'

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
  if (/^https?:\/\//i.test(s)) return [await downloadToFile(s)]
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
