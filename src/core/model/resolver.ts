// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Models/MediaResolver.swift (GPL-3.0, © Palmier, Inc.)
//
// Upstream also performs FileManager existence checks; those live in the Electron main
// process (where `fs` is available). Here we keep only the pure id → path computation so
// this module stays usable in the renderer and in unit tests.

import type { MediaManifest, MediaManifestEntry } from './manifest'

export function entryFor(manifest: MediaManifest, assetId: string): MediaManifestEntry | undefined {
  return manifest.entries.find((e) => e.id === assetId)
}

/** Join with a forward slash; project-relative paths use POSIX separators in the manifest. */
function joinPath(base: string, rel: string): string {
  const b = base.replace(/[/\\]+$/, '')
  const r = rel.replace(/^[/\\]+/, '')
  return `${b}/${r}`
}

/** The path an asset is expected at, given the project package directory (for project sources). */
export function expectedPath(manifest: MediaManifest, assetId: string, projectDir: string | null): string | null {
  const entry = entryFor(manifest, assetId)
  if (!entry) return null
  switch (entry.source.type) {
    case 'external':
      return entry.source.absolutePath
    case 'project':
      if (!projectDir) return null
      return joinPath(projectDir, entry.source.relativePath)
  }
}

export function displayName(manifest: MediaManifest, assetId: string): string {
  return entryFor(manifest, assetId)?.name ?? 'Offline'
}
