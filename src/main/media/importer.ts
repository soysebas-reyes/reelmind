// SPDX-License-Identifier: GPL-3.0-or-later
// Imports external media files: classify by extension, probe metadata, build a manifest entry
// (external source), and render a thumbnail. Assets are referenced in place (not copied) in P1.

import { basename, extname } from 'node:path'
import { Defaults, type MediaManifestEntry, clipTypeForExtension, newId } from '../../core'
import type { ImportedAsset } from '../../shared/ipc'
import { generateThumbnail, probeMedia } from '../ffmpeg'

export async function importMedia(paths: string[]): Promise<ImportedAsset[]> {
  const results: ImportedAsset[] = []

  for (const filePath of paths) {
    const ext = extname(filePath).replace(/^\./, '')
    const type = clipTypeForExtension(ext)
    if (!type) continue

    let durationSeconds = 0
    let sourceWidth: number | undefined
    let sourceHeight: number | undefined
    let sourceFPS: number | undefined
    let hasAudio = false

    if (type === 'video' || type === 'audio' || type === 'image') {
      try {
        const probe = await probeMedia(filePath)
        durationSeconds = probe.durationSeconds
        sourceWidth = probe.width
        sourceHeight = probe.height
        sourceFPS = probe.fps
        hasAudio = probe.hasAudio
      } catch {
        // leave defaults; asset still imports, just without metadata
      }
    }

    if (type === 'image' && (!durationSeconds || durationSeconds <= 0)) {
      durationSeconds = Defaults.imageDurationSeconds
    }

    const entry: MediaManifestEntry = {
      id: newId(),
      name: basename(filePath),
      type,
      source: { type: 'external', absolutePath: filePath },
      duration: durationSeconds,
      sourceWidth,
      sourceHeight,
      sourceFPS,
      hasAudio
    }

    const thumbnail = await generateThumbnail(filePath, { type, durationSeconds })
    results.push({ entry, thumbnail })
  }

  return results
}
