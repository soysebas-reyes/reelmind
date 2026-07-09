// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Models/MediaManifest.swift + MediaFolder.swift
// (GPL-3.0, © Palmier, Inc.)

import type { ClipType } from './clipType'

/** Where an asset's bytes live. `project` paths are relative to the .vproj package root. */
export type MediaSource =
  | { type: 'external'; absolutePath: string }
  | { type: 'project'; relativePath: string }

/** Provenance for AI-generated media. Populated in the generation phases. */
export interface GenerationInput {
  prompt: string
  model: string
  duration: number
  aspectRatio: string
  resolution?: string
  quality?: string
  imageURLs?: string[]
  numImages?: number
  voice?: string
  lyrics?: string
  styleInstructions?: string
  instrumental?: boolean
  generateAudio?: boolean
  referenceImageURLs?: string[]
  referenceVideoURLs?: string[]
  referenceAudioURLs?: string[]
  createdAt?: string
}

export interface MediaManifestEntry {
  id: string
  name: string
  type: ClipType
  source: MediaSource
  duration: number
  sourceWidth?: number
  sourceHeight?: number
  sourceFPS?: number
  hasAudio?: boolean
  folderId?: string
  generationInput?: GenerationInput
  /** Absolute path to a preview-friendly proxy (720p H.264 yuv420p). Used ONLY for smooth
   *  preview playback of hard-to-decode sources (4K / 10-bit / 4:2:2); export uses the original. */
  proxyPath?: string
  /** Encoder-recipe version the `proxyPath` was built with (see PROXY_VERSION). When it differs from the
   *  current version on project open, the proxy is stale (e.g. built with a coarser GOP) and is
   *  regenerated in the background. Absent on proxies from before versioning → treated as stale. */
  proxyVersion?: number
}

export interface MediaFolder {
  id: string
  name: string
  parentFolderId?: string
}

export interface MediaManifest {
  version: number
  entries: MediaManifestEntry[]
  folders: MediaFolder[]
}

export const MANIFEST_VERSION = 2

export function makeManifest(p: Partial<MediaManifest> = {}): MediaManifest {
  return {
    version: p.version ?? MANIFEST_VERSION,
    entries: p.entries ?? [],
    folders: p.folders ?? []
  }
}

export interface AssetListing {
  assetId: string
  name: string
  type: ClipType
  durationSeconds: number
  width?: number
  height?: number
  fps?: number
  hasAudio?: boolean
  folderId?: string
  hasProxy: boolean
}

/** Serializable bin listing for the `list_assets` tool (pure — testable without the store). */
export function manifestToAssetList(manifest: MediaManifest, type?: ClipType): AssetListing[] {
  return manifest.entries
    .filter((e) => type === undefined || e.type === type)
    .map((e) => ({
      assetId: e.id,
      name: e.name,
      type: e.type,
      durationSeconds: e.duration,
      width: e.sourceWidth,
      height: e.sourceHeight,
      fps: e.sourceFPS,
      hasAudio: e.hasAudio,
      folderId: e.folderId,
      hasProxy: e.proxyPath !== undefined
    }))
}
