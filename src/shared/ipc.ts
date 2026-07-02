// SPDX-License-Identifier: GPL-3.0-or-later
// Wire types shared across main, preload, and renderer (type-only; no runtime code).

import type {
  AudioEnhanceSettings,
  ClipType,
  ColorAdjustments,
  MediaManifest,
  MediaManifestEntry,
  SilenceSeconds,
  Timeline
} from '../core'

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

/** media:enhanceAudio — re-render a clip's audio through a voice-cleanup chain (high-pass + denoise +
 *  compression + loudness normalization) to a new .m4a. */
export interface EnhanceAudioRequest extends Partial<AudioEnhanceSettings> {
  srcPath: string
  /** Where to write the .m4a; null → the host's userData/imported folder. */
  outDir: string | null
}
export interface EnhanceAudioResult {
  ok: boolean
  outputPath?: string
  error?: string
}

/** media:enhanceAudioPreview — render a short raw + enhanced snippet of a clip's audio for the A/B
 *  player in the audio modal. Returns both as base64 data URLs (no file:// needed). */
export interface AudioPreviewRequest {
  srcPath: string
  startSec: number
  durationSec: number
  settings: AudioEnhanceSettings
}
export interface AudioPreviewResult {
  ok: boolean
  /** `data:audio/mp4;base64,…` of the unprocessed window. */
  rawDataUrl?: string
  /** `data:audio/mp4;base64,…` of the window through the enhance chain. */
  enhancedDataUrl?: string
  error?: string
}

/** media:generateProxy — transcode a video to a preview-friendly 1080p H.264 proxy. */
export interface GenerateProxyRequest {
  srcPath: string
  /** Where to write the proxy; null → the host's userData/imported folder. */
  outDir: string | null
}
export interface GenerateProxyResult {
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

/** A single word (or spacing/audio-event) from ElevenLabs Scribe, with ms-accurate timestamps. */
export interface TranscriptWord {
  text: string
  startMs: number
  endMs: number
  type: 'word' | 'spacing' | 'audio_event'
  speakerId: string | null
}

/** Request for `ai:transcribe` — run ElevenLabs STT on a media file. */
export interface TranscribeRequest {
  /** Absolute path to the source video/audio file. */
  mediaPath: string
  languageCode?: string
  /** Enable speaker diarization (who said what). */
  diarize?: boolean
}

export interface TranscribeResult {
  ok: boolean
  text?: string
  words?: TranscriptWord[]
  error?: string
}

/** ai:isolateVoice — ElevenLabs Audio Isolation: ML voice cleanup (removes noise/music/reverb) → new
 *  .m4a. The destructive "clean the source" pass; the per-clip `audioEnhance` DSP shapes tone on top. */
export interface IsolateVoiceRequest {
  /** Absolute path to the source audio/video file. */
  srcPath: string
  /** Where to write the .m4a; null → the host's userData/imported folder. */
  outDir: string | null
  /** Dry/wet blend 0..1 (CapCut-style intensity): 1 = fully isolated voice; <1 mixes back some of the
   *  original so it stays natural (not "dead"). Defaults to 1 when omitted. */
  intensity?: number
  /** Constant-background reduction 0..1 (kills a steady fan/HVAC/hiss left after isolation). 0 = off. */
  denoise?: number
}
export interface IsolateVoiceResult {
  ok: boolean
  outputPath?: string
  error?: string
}

/** ai:previewIsolateVoice — isolate a short WINDOW for the modal A/B (cheap ElevenLabs call per click).
 *  Returns the raw window + the isolated window as base64 data URLs (no clip is touched). */
export interface PreviewIsolateRequest {
  srcPath: string
  startSec: number
  durationSec: number
  intensity?: number
  denoise?: number
}
export interface PreviewIsolateResult {
  ok: boolean
  /** `data:audio/mp4;base64,…` of the unprocessed window (A/B "Original"). */
  rawDataUrl?: string
  /** `data:audio/mp4;base64,…` of the isolated + denoised window (A/B "Mejorado" base). */
  isolatedDataUrl?: string
  error?: string
}

/** One-way main→renderer progress event for long-running ops (mirrors `export:progress`).
 *  `stage` is a coarse label ('silences' | 'extract' | 'uploading' | …); `line` is a raw backend log line. */
export interface OpProgressEvent {
  stage: string
  line?: string
}

/** Result of `media:analyzeIntensity` — loudness envelope + emphasis peaks for the angle-cut preview. */
export interface IntensityAnalysisResult {
  ok: boolean
  /** Normalized 0..1 loudness envelope (compact, for drawing the waveform). */
  envelope?: number[]
  /** Display points per second. */
  envelopeRate?: number
  /** Emphasis peak times in seconds. */
  peaks?: number[]
  /** Pause midpoint times in seconds (relative-threshold, level-independent). */
  pauses?: number[]
  durationSec?: number
  error?: string
}

export const PROJECT_SCHEMA_VERSION = 1
