// SPDX-License-Identifier: GPL-3.0-or-later
// Pure bin listing for the `list_assets` tool.

import { describe, expect, it } from 'vitest'
import { type MediaManifestEntry, isProxyStale, makeManifest, manifestToAssetList } from './manifest'

const manifest = makeManifest({
  entries: [
    {
      id: 'v1',
      name: 'toma1.mp4',
      type: 'video',
      source: { type: 'external', absolutePath: 'D:/crudos/toma1.mp4' },
      duration: 12.5,
      sourceWidth: 3840,
      sourceHeight: 2160,
      sourceFPS: 30,
      hasAudio: true,
      proxyPath: 'C:/cache/toma1-proxy.mp4'
    },
    {
      id: 'a1',
      name: 'musica.mp3',
      type: 'audio',
      source: { type: 'external', absolutePath: 'D:/crudos/musica.mp3' },
      duration: 95
    }
  ]
})

describe('manifestToAssetList', () => {
  it('maps entries to serializable listings with proxy status', () => {
    const all = manifestToAssetList(manifest)
    expect(all).toHaveLength(2)
    expect(all[0]).toMatchObject({
      assetId: 'v1',
      name: 'toma1.mp4',
      type: 'video',
      durationSeconds: 12.5,
      width: 3840,
      height: 2160,
      fps: 30,
      hasAudio: true,
      hasProxy: true
    })
    expect(all[1].hasProxy).toBe(false)
    expect(() => JSON.stringify(all)).not.toThrow()
  })

  it('filters by type', () => {
    expect(manifestToAssetList(manifest, 'audio').map((a) => a.assetId)).toEqual(['a1'])
    expect(manifestToAssetList(manifest, 'text')).toHaveLength(0)
  })
})

describe('isProxyStale', () => {
  const v = (over: Partial<MediaManifestEntry>): MediaManifestEntry => ({
    id: 'x',
    name: 'x.mp4',
    type: 'video',
    source: { type: 'external', absolutePath: 'D:/x.mp4' },
    duration: 1,
    ...over
  })
  it('is stale when a proxy exists at an older recipe version', () => {
    expect(isProxyStale(v({ proxyPath: 'C:/x-proxy-v2.mp4', proxyVersion: 2 }), 3)).toBe(true)
  })
  it('is not stale when the proxy version matches (by absolute or relative path)', () => {
    expect(isProxyStale(v({ proxyPath: 'C:/x-proxy-v3.mp4', proxyVersion: 3 }), 3)).toBe(false)
    expect(isProxyStale(v({ proxyRelativePath: 'proxies/x-proxy-v3.mp4', proxyVersion: 3 }), 3)).toBe(false)
  })
  it('treats a proxy with no version (pre-versioning) as stale', () => {
    expect(isProxyStale(v({ proxyPath: 'C:/x-proxy-legacy.mp4' }), 3)).toBe(true)
  })
  it('is NOT "stale" when there is no proxy at all (absent ≠ stale)', () => {
    expect(isProxyStale(v({}), 3)).toBe(false)
  })
  it('ignores non-video entries', () => {
    expect(isProxyStale(v({ type: 'audio', proxyPath: 'C:/a-proxy-v2.mp4', proxyVersion: 2 }), 3)).toBe(false)
  })
})
