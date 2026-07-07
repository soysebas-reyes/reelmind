// SPDX-License-Identifier: GPL-3.0-or-later
// Persists ElevenLabs transcripts in the project's `cache/` directory, keyed by manifest `mediaRef`, so
// every feature that needs a transcript (segmentar por guiones, cambios de ángulo, sincronizar ángulos)
// reuses it across reopens instead of re-transcribing (network latency + ElevenLabs cost). Mirrors the
// proxy pattern: derived artifact stored beside the project, reloaded on open. Atomic per-write.

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ProjectFiles } from '../../core'
import type { TranscriptWord } from '../../shared/ipc'

interface StoredTranscript {
  words: TranscriptWord[]
  savedAt: string
}
interface TranscriptCacheFile {
  version: number
  /** mediaRef (manifest entry id) → cached transcript. */
  transcripts: Record<string, StoredTranscript>
}

const CACHE_FILE = 'transcripts.json'

function cachePath(projectDir: string): string {
  return join(projectDir, ProjectFiles.cacheDirectoryName, CACHE_FILE)
}

async function readCache(projectDir: string): Promise<TranscriptCacheFile> {
  try {
    return JSON.parse(await fs.readFile(cachePath(projectDir), 'utf8')) as TranscriptCacheFile
  } catch {
    return { version: 1, transcripts: {} }
  }
}

/** Upsert one source's transcript into `cache/transcripts.json` (atomic temp+rename, like projectStore). */
export async function saveTranscript(projectDir: string, mediaRef: string, words: TranscriptWord[]): Promise<void> {
  await fs.mkdir(join(projectDir, ProjectFiles.cacheDirectoryName), { recursive: true })
  const cache = await readCache(projectDir)
  cache.transcripts[mediaRef] = { words, savedAt: new Date().toISOString() }
  const path = cachePath(projectDir)
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(cache), 'utf8')
  await fs.rename(tmp, path)
}

/** All cached transcripts keyed by mediaRef (empty object if none / unreadable). */
export async function loadTranscripts(projectDir: string): Promise<Record<string, TranscriptWord[]>> {
  const cache = await readCache(projectDir)
  const out: Record<string, TranscriptWord[]> = {}
  for (const [ref, t] of Object.entries(cache.transcripts)) if (t?.words) out[ref] = t.words
  return out
}
