// SPDX-License-Identifier: GPL-3.0-or-later
// Wire types shared across main, preload, and renderer (type-only; no runtime code).

import type { ClipType, ColorAdjustments, MediaManifest, MediaManifestEntry, SilenceSeconds, Timeline } from '../core'

export type { SilenceSeconds }

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

/** Export quality tier → CRF (mapped host-side). Higher tier = bigger file, closer to the source. */
export type ExportQuality = 'high' | 'veryHigh' | 'max'

export interface ExportRequest {
  timeline: Timeline
  manifest: MediaManifest
  projectDir: string | null
  outputPath: string
  quality?: ExportQuality
}

export interface ExportResult {
  ok: boolean
  outputPath?: string
  error?: string
  durationSeconds?: number
}

/** AI completion proxy. The renderer builds Anthropic-shaped `messages`/`tools` and the main
 *  process attaches the key and calls the API. Typed loosely here so neither shared nor renderer
 *  depends on the Anthropic SDK types. */
export interface AiCompleteRequest {
  system: string
  messages: unknown[]
  tools: unknown[]
  model?: string
  maxTokens?: number
}

export interface AiCompleteResponse {
  ok: boolean
  error?: string
  stopReason?: string | null
  content?: unknown[]
}

/** Request for the `media:detectSilences` IPC — analyze one media file's audio for silent spans. */
export interface DetectSilencesRequest {
  path: string
  noiseDb?: number
  minDurationSec?: number
}

/** Request for `color:still` — render one color-graded preview frame as a base64 data URL (P9.5). */
export interface ColorStillRequest {
  mediaPath: string
  seekSeconds: number
  color: ColorAdjustments
  width?: number
  projectDir: string | null
}

/** Request for `color:lutData` — resolve a logical `lutRef` and parse it into 3D-LUT grid data so the
 *  renderer's WebGL preview can sample the same `.cube` the FFmpeg export uses (live-playback LUT). */
export interface ColorLutDataRequest {
  lutRef: string
  projectDir: string | null
}

/** Parsed 3D LUT for the renderer: `size³` RGB triplets, red varying fastest (a plain `number[]` so it
 *  crosses the IPC boundary cleanly; the renderer wraps it in a `Float32Array` for `texImage3D`). */
export interface ColorLutData {
  size: number
  data: number[]
}

/** media:extractAudio — pull a video's audio track into a standalone file (then imported as an asset). */
export interface ExtractAudioRequest {
  videoPath: string
  /** Where to write the .m4a; null → the host's userData/imported folder. */
  outDir: string | null
}
export interface ExtractAudioResult {
  ok: boolean
  outputPath?: string
  error?: string
}

/** media:computeAudioOffset — cross-correlate two videos' audio to find their time offset (multicam). */
export interface AudioOffsetRequest {
  pathA: string
  pathB: string
  fps: number
}
export interface AudioOffsetResult {
  ok: boolean
  /** B relative to A; positive ⇒ B started later. */
  offsetSeconds?: number
  offsetFrames?: number
  confidence?: number
  reliable?: boolean
  error?: string
}

export const PROJECT_SCHEMA_VERSION = 1
