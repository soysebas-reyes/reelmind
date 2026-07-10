// SPDX-License-Identifier: GPL-3.0-or-later
// Reads/writes the .vproj directory package. Inspired by upstream's FileWrapper-based
// VideoProject/PalmierProjectExporter, adapted to a plain folder + atomic JSON writes.

import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { ProjectFiles, makeManifest, makeTimeline } from '../../core'
import { PROJECT_SCHEMA_VERSION, PROXY_VERSION, type ProjectData, type ProjectMeta } from '../../shared/ipc'
import { consolidateProxies, resolveProxyPaths } from '../ffmpeg'

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Write the whole project package. Atomic per-file (temp + rename) so a crash can't corrupt. */
export async function saveProject(dir: string, data: ProjectData): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(join(dir, ProjectFiles.mediaDirectoryName), { recursive: true })
  await fs.mkdir(join(dir, ProjectFiles.cacheDirectoryName), { recursive: true })
  // Make the project self-contained: copy each referenced proxy into `proxies/`, rewrite entries to a
  // package-relative path (dropping the machine-specific absolute one), and sweep orphan proxy files.
  // Covers the active manifest + every session's manifest (they share sources). Mutates the copy `data`
  // received over IPC — safe, it's not the renderer's live object.
  const manifests = [data.manifest, ...(data.sessions?.sessions.map((s) => s.manifest) ?? [])]
  await consolidateProxies(dir, manifests, PROXY_VERSION)
  const meta: ProjectMeta = { ...data.meta, schemaVersion: PROJECT_SCHEMA_VERSION, modifiedAt: new Date().toISOString() }
  await writeJsonAtomic(join(dir, ProjectFiles.projectFilename), meta)
  await writeJsonAtomic(join(dir, ProjectFiles.timelineFilename), data.timeline)
  await writeJsonAtomic(join(dir, ProjectFiles.manifestFilename), data.manifest)
  // Persist ALL tabs (raw project + guión tabs) so segmentation survives reopen. Absent = single-session.
  if (data.sessions) await writeJsonAtomic(join(dir, ProjectFiles.sessionsFilename), data.sessions)
}

/** Read a project package, tolerating missing/old files with sensible defaults. */
export async function loadProject(dir: string): Promise<ProjectData> {
  const meta = (await readJson<ProjectMeta>(join(dir, ProjectFiles.projectFilename))) ?? {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: basename(dir).replace(/\.vproj$/i, ''),
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString()
  }
  const timeline = (await readJson<ProjectData['timeline']>(join(dir, ProjectFiles.timelineFilename))) ?? makeTimeline()
  const manifest = (await readJson<ProjectData['manifest']>(join(dir, ProjectFiles.manifestFilename))) ?? makeManifest()
  const sessions = (await readJson<ProjectData['sessions']>(join(dir, ProjectFiles.sessionsFilename))) ?? undefined
  // Resolve package-relative proxy paths back into absolute runtime paths (active manifest + every session).
  resolveProxyPaths(dir, manifest)
  if (sessions) for (const s of sessions.sessions) resolveProxyPaths(dir, s.manifest)
  return { meta, timeline, manifest, sessions }
}
