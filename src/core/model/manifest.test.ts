// SPDX-License-Identifier: GPL-3.0-or-later
// Pure bin listing for the `list_assets` tool.

import { describe, expect, it } from 'vitest'
import { makeManifest, manifestToAssetList } from './manifest'

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
