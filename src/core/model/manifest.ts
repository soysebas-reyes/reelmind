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
