// SPDX-License-Identifier: GPL-3.0-or-later
// Proxy filename version parsing + reconcile (fs-only; no ffmpeg). Guards the "re-optimize on every
// reopen" fix: a proxy found on disk is relinked WITH its recipe version so it isn't re-flagged stale.

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type MediaManifest, makeManifest } from '../../core'
import { parseProxyVersion, reconcileProxies } from './proxy'

describe('parseProxyVersion', () => {
  it('parses the recipe version from a versioned proxy name', () => {
    expect(parseProxyVersion('C0480-proxy-v3.mp4')).toBe(3)
    expect(parseProxyVersion('C0480-proxy-v12.mp4')).toBe(12)
  })
  it('returns undefined for a legacy random-uuid name', () => {
    expect(parseProxyVersion('C0480-proxy-ba2dba60-0993.mp4')).toBeUndefined()
    expect(parseProxyVersion('C0480.mp4')).toBeUndefined()
  })
})

describe('reconcileProxies', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'reelo-proxy-'))
  })
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })

  function manifestNoProxy(): MediaManifest {
    return makeManifest({
      entries: [
        { id: 'v1', name: 'C0480.MP4', type: 'video', source: { type: 'external', absolutePath: 'C:/footage/C0480.MP4' }, duration: 10 }
      ]
    })
  }

  it('relinks a proxy found in proxies/ and carries its parsed version', async () => {
    await fs.mkdir(join(dir, 'proxies'), { recursive: true })
    const p = join(dir, 'proxies', 'C0480-proxy-v3.mp4')
    await fs.writeFile(p, 'x')
    const rel = await reconcileProxies(manifestNoProxy(), dir)
    expect(rel).toEqual([{ id: 'v1', proxyPath: p, proxyVersion: 3 }])
  })

  it('prefers the highest recipe version when several exist', async () => {
    await fs.mkdir(join(dir, 'proxies'), { recursive: true })
    await fs.writeFile(join(dir, 'proxies', 'C0480-proxy-v2.mp4'), 'x')
    const v3 = join(dir, 'proxies', 'C0480-proxy-v3.mp4')
    await fs.writeFile(v3, 'x')
    const rel = await reconcileProxies(manifestNoProxy(), dir)
    expect(rel).toEqual([{ id: 'v1', proxyPath: v3, proxyVersion: 3 }])
  })

  it('returns nothing when the entry proxyPath already resolves', async () => {
    const existing = join(dir, 'C0480-proxy-v3.mp4')
    await fs.writeFile(existing, 'x')
    const m = manifestNoProxy()
    m.entries[0].proxyPath = existing
    const rel = await reconcileProxies(m, dir)
    expect(rel).toEqual([])
  })
})
