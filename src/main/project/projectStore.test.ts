// SPDX-License-Identifier: GPL-3.0-or-later
// Persistence round-trips: (1) a synced multicam take's per-track startFrame offset survives save→load
// verbatim (the "alignment lost on reopen" bug), and (2) a proxy is consolidated INTO the package with a
// relative path on save and resolved back to absolute on load, with orphans swept (the "re-optimizes on
// every reopen / duplicate proxies" bug). Real filesystem, no ffmpeg needed.

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type MediaManifestEntry,
  makeClip,
  makeManifest,
  makeTimeline,
  makeTrack
} from '@core'
import type { ProjectData } from '../../shared/ipc'
import { loadProject, saveProject } from './projectStore'

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'reelo-vproj-'))
})
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true })
})

function meta() {
  return { schemaVersion: 1, name: 'T', createdAt: '2020-01-01T00:00:00Z', modifiedAt: '2020-01-01T00:00:00Z' }
}

describe('projectStore save/load — multicam alignment survives reopen', () => {
  it('preserves each track head verbatim (frontal 0 / lateral 16 / audio 0)', async () => {
    const frontal = { ...makeClip({ id: 'F', mediaRef: 'v1', startFrame: 0, durationFrames: 60 }), linkGroupId: 'g1' }
    const lateral = { ...makeClip({ id: 'L', mediaRef: 'v2', startFrame: 16, durationFrames: 60 }), linkGroupId: 'g1' }
    const audio = makeClip({ id: 'A', mediaRef: 'a1', mediaType: 'audio', startFrame: 0, durationFrames: 1000 })
    const timeline = makeTimeline({
      fps: 24,
      tracks: [
        makeTrack({ id: 't0', type: 'video', role: 'frontal', clips: [frontal] }),
        makeTrack({ id: 't1', type: 'video', role: 'lateral', clips: [lateral] }),
        makeTrack({ id: 't2', type: 'audio', clips: [audio] })
      ]
    })
    const data: ProjectData = {
      meta: meta(),
      timeline,
      manifest: makeManifest(),
      sessions: {
        version: 1,
        activeId: 's1',
        sessions: [
          { id: 's1', name: 'Guión 1', createdAt: '2020-01-01T00:00:00Z', timeline, manifest: makeManifest(), exportQuality: 'high' }
        ]
      }
    }

    await saveProject(dir, data)
    const loaded = await loadProject(dir)

    const sess = loaded.sessions!.sessions[0]
    const [fr, lat, au] = sess.timeline.tracks
    expect(fr.clips[0].startFrame).toBe(0)
    expect(lat.clips[0].startFrame).toBe(16) // the sync offset is NOT collapsed
    expect(au.clips[0].startFrame).toBe(0)
    expect(lat.clips[0].linkGroupId).toBe('g1')
  })
})

describe('projectStore save/load — proxy consolidation (portable + no re-optimize)', () => {
  function videoEntry(proxyPath: string): MediaManifestEntry {
    return {
      id: 'v1',
      name: 'C0480.MP4',
      type: 'video',
      source: { type: 'external', absolutePath: 'C:/footage/C0480.MP4' },
      duration: 10,
      proxyPath,
      proxyVersion: 3
    }
  }

  it('copies the proxy into proxies/, writes a relative path, and resolves it back on load', async () => {
    // A proxy sitting in an external cache (as if generated before the project had a folder).
    const cacheDir = await fs.mkdtemp(join(tmpdir(), 'reelo-cache-'))
    const cacheProxy = join(cacheDir, 'C0480-proxy-v3.mp4')
    await fs.writeFile(cacheProxy, 'proxy-bytes')

    const data: ProjectData = { meta: meta(), timeline: makeTimeline(), manifest: makeManifest({ entries: [videoEntry(cacheProxy)] }) }
    await saveProject(dir, data)

    // Consolidated into the package.
    const inPkg = join(dir, 'proxies', 'C0480-proxy-v3.mp4')
    await expect(fs.stat(inPkg)).resolves.toBeTruthy()

    // Written manifest: relative path, NO machine-specific absolute path.
    const written = JSON.parse(await fs.readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(written.entries[0].proxyRelativePath).toBe('proxies/C0480-proxy-v3.mp4')
    expect(written.entries[0].proxyPath).toBeUndefined()
    expect(written.entries[0].proxyVersion).toBe(3)

    // Load resolves relative → absolute for runtime use.
    const loaded = await loadProject(dir)
    expect(loaded.manifest.entries[0].proxyPath).toBe(inPkg)
    expect(loaded.manifest.entries[0].proxyRelativePath).toBe('proxies/C0480-proxy-v3.mp4')

    await fs.rm(cacheDir, { recursive: true, force: true })
  })

  it('sweeps orphan / legacy-named proxy files that are not referenced', async () => {
    const cacheDir = await fs.mkdtemp(join(tmpdir(), 'reelo-cache-'))
    const cacheProxy = join(cacheDir, 'C0480-proxy-v3.mp4')
    await fs.writeFile(cacheProxy, 'proxy-bytes')

    // Pre-existing legacy duplicate in the package root (random-uuid name, unreferenced).
    await fs.mkdir(dir, { recursive: true })
    const legacy = join(dir, 'C0480-proxy-ba2dba60-old.mp4')
    await fs.writeFile(legacy, 'stale')

    const data: ProjectData = { meta: meta(), timeline: makeTimeline(), manifest: makeManifest({ entries: [videoEntry(cacheProxy)] }) }
    await saveProject(dir, data)

    await expect(fs.stat(legacy)).rejects.toBeTruthy() // orphan removed
    await expect(fs.stat(join(dir, 'proxies', 'C0480-proxy-v3.mp4'))).resolves.toBeTruthy() // current kept

    await fs.rm(cacheDir, { recursive: true, force: true })
  })
})
