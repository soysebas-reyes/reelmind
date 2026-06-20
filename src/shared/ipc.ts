// SPDX-License-Identifier: GPL-3.0-or-later
// Wire types shared across main, preload, and renderer (type-only; no runtime code).

import type { ClipType, MediaManifest, MediaManifestEntry, Timeline } from '../core'

export interface FfmpegStatus {
  ffmpeg: boolean
  ffprobe: boolean
  ffmpegVersion?: string
}

export interface ImportedAsset {
  entry: MediaManifestEntry
  /** base64 data URL (poster frame, image thumb, or audio waveform), or null if none. */
  thumbnail: string | null
}

export interface ThumbnailRequest {
  id: string
  path: string
  type: ClipType
  durationSeconds: number
}

export interface ThumbnailResult {
  id: string
  thumbnail: string | null
}

export interface ProjectMeta {
  schemaVersion: number
  name: string
  createdAt: string
  modifiedAt: string
}

export interface ProjectData {
  meta: ProjectMeta
  timeline: Timeline
  manifest: MediaManifest
}

export interface SaveResult {
  ok: boolean
  error?: string
}

export interface ExportRequest {
  timeline: Timeline
  manifest: MediaManifest
  projectDir: string | null
  outputPath: string
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  error?: string
  durationSeconds?: number
}

export const PROJECT_SCHEMA_VERSION = 1
