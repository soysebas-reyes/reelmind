// SPDX-License-Identifier: GPL-3.0-or-later
// Wire types shared across main, preload, and renderer (type-only; no runtime code).

import type {
  AudioEnhanceSettings,
  ClipType,
  ColorAdjustments,
  MediaManifest,
  MediaManifestEntry,
  SilenceSeconds,
  TakesPlanResult,
  TelemetryCategory,
  TelemetryConfig,
  TelemetryContext,
  TelemetryEvent,
  Timeline
} from '../core'

export type { TakesPlanResult }

export type { SilenceSeconds }

// Telemetry wire types (canonical definitions + TELEMETRY_SCHEMA_VERSION live in
// src/core/telemetry/event.ts; the renderer client and main sink import the schema/version
// directly from @core). See docs/TOTAL_MEASUREMENT_PLAN.md.
export type { TelemetryCategory, TelemetryConfig, TelemetryContext, TelemetryEvent }

export interface FfmpegStatus {
  ffmpeg: boolean
  ffprobe: boolean
  ffmpegVersion?: string
}

/** elevenlabs:keyStatus — whether an ElevenLabs key is available and where it comes from.
 *  'env' (dev .env / process env, takes precedence) or 'stored' (safeStorage via Ajustes). */
export interface ElevenLabsKeyStatus {
  present: boolean
  source: 'env' | 'stored' | null
}

/** update:status — normalized electron-updater state broadcast to all windows. */
export type UpdateStatus = 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error' | 'dev'

export interface UpdateStatusEvent {
  status: UpdateStatus
  /** Remote version (available/downloaded) or the current one (none). */
  version?: string
  /** Download progress 0..100 (downloading). */
  percent?: number
  error?: string
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

/** One editor tab (session) persisted with the project so the guión tabs survive reopen. The controller
 *  is rebuilt from `timeline`; thumbnails are regenerated on load; transcript lives in the cache. */
export interface PersistedSession {
  id: string
  name: string
  createdAt: string
  timeline: Timeline
  manifest: MediaManifest
  exportQuality: ExportQuality
}
export interface SessionsData {
  version: number
  /** Which tab was focused. */
  activeId: string
  sessions: PersistedSession[]
}

export interface ProjectData {
  meta: ProjectMeta
  timeline: Timeline
  manifest: MediaManifest
  /** All open tabs (raw project + guión tabs). Absent for old single-session projects. */
  sessions?: SessionsData
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

/** Handoff (interchange) target. `premiere`/`resolve`/`finalcut`/`universal` all emit one FCP7 xmeml
 *  (the labels drive UI copy); `capcut` emits a CapCut draft folder (draft_content + draft_meta_info). */
export type NleTarget = 'premiere' | 'resolve' | 'finalcut' | 'universal' | 'capcut'

/** Export an EDITABLE NLE project (XML) + baked media (our grade + audio enhancement pre-applied). */
export interface HandoffRequest {
  timeline: Timeline
  manifest: MediaManifest
  projectDir: string | null
  projectName: string
  /** Directory the user picked; the handoff folder is created inside it. */
  outDir: string
  target: NleTarget
  /** Bake whole sources instead of just the used range (bigger files, wider re-trim). */
  fullLength?: boolean
  /** CapCut only: `outDir` is CapCut's auto-detected draft root, so the draft lands inside CapCut
   *  directly (drives README wording). false/undefined → the user picked an arbitrary folder. */
  capcutAutoPlaced?: boolean
}

export interface HandoffResult {
  ok: boolean
  /** Absolute path to the written .xml. */
  xmlPath?: string
  /** Absolute path to the handoff folder (media + xml + luts + README). */
  folder?: string
  bakedCount?: number
  referencedCount?: number
  /** Clips laid out in the project (xmeml clipitems or CapCut segments). */
  clipItemCount?: number
  warnings?: string[]
  error?: string
  /** True when the target was CapCut (a draft folder, not an xmeml package) — drives result UI copy. */
  isCapCut?: boolean
  /** CapCut only: the draft landed inside CapCut's auto-detected draft root (appears in CapCut directly). */
  placedInCapCut?: boolean
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
  /** Anthropic `tool_choice` (e.g. `{ type: 'tool', name: 'emitir_plan' }`) to force a structured
   *  single-tool response. Omitted by the chat agent, so its behavior is unchanged. */
  toolChoice?: unknown
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

/** media:generateProxy — transcode a video to a preview-friendly 720p H.264 proxy. */
export interface GenerateProxyRequest {
  srcPath: string
  /** The project root. When set, the proxy is written inside `<projectDir>/proxies/` (self-contained
   *  project); null → the host's userData/imported cache (project not saved yet). */
  projectDir: string | null
  /** Encoder-recipe version, baked into the deterministic filename (`…-proxy-v<version>.mp4`) so a
   *  regen OVERWRITES the same file instead of accumulating a new random-named one. */
  version: number
}
export interface GenerateProxyResult {
  ok: boolean
  outputPath?: string
  error?: string
}

/** media:reconcileProxies — re-link preview proxies already present on disk (reopened project reuses them
 *  instead of regenerating). Returns only the entries whose proxyPath should change. */
export interface ReconcileProxiesRequest {
  manifest: MediaManifest
  projectDir: string | null
}
export interface ReconcileProxiesResult {
  ok: boolean
  /** `proxyVersion` (parsed from the `…-proxy-v<n>.mp4` filename) travels with the relink so the caller
   *  re-stamps it — otherwise a still-current proxy that merely moved would be re-flagged as stale. */
  relinked?: { id: string; proxyPath: string; proxyVersion?: number }[]
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
  /** Peak minus best score outside the peak neighborhood — higher ⇒ sharper, more trustworthy peak. */
  margin?: number
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

/** transcript:save / transcript:load — persist ElevenLabs transcripts in the project `cache/` (keyed by
 *  mediaRef) so every transcript-consuming feature reuses them across reopens instead of re-transcribing. */
export interface SaveTranscriptRequest {
  projectDir: string
  mediaRef: string
  words: TranscriptWord[]
}
export interface SaveTranscriptResult {
  ok: boolean
  error?: string
}
export interface LoadTranscriptsResult {
  ok: boolean
  /** mediaRef → words. */
  transcripts?: Record<string, TranscriptWord[]>
  error?: string
}

/** Request for `ai:analyzeTakes` — segment a raw clip's transcript into takes + cuts via the LLM.
 *  We pass the already-fetched `words` (not a path) so main never re-transcribes. */
export interface AnalyzeTakesRequest {
  words: TranscriptWord[]
  /** ISO 639-1 language of the content (e.g. "es"). Informational; the analysis is language-agnostic. */
  languageCode?: string
  /** Optional: the actual scripts (guiones) the user recorded, pasted as text (one per block). When
   *  provided, the LLM aligns each script to its span in the transcript instead of inferring boundaries. */
  scripts?: string
  /** Cut fillers/repeats/silences inside each take. Default false → bring each guión's WHOLE fragment
   *  uncut (repeats and all). Opt-in; the user reviews every cut before applying. */
  cleanCuts?: boolean
  /** Path of the transcribed media (the SAME file the `words` came from). When present and cleanCuts is
   *  on, main runs silencedetect on it to refine cuts against real acoustic silence. */
  mediaPath?: string
  /** "Aire" a conservar entre frases (ms de silencio que sobrevive a cada corte). Default 250 (Natural).
   *  Se reparte a cada lado del corte de silencio; valores mayores = ritmo más relajado. */
  airMs?: number
}

export interface AnalyzeTakesResult {
  ok: boolean
  plan?: TakesPlanResult
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

/** Bumped whenever the proxy encoder recipe changes (resolution, GOP, codec args). A saved manifest
 *  entry whose `proxyVersion` differs from this is treated as stale on open and regenerated in the
 *  background. v2 = 720p + GOP 12 (denser keyframes for snappy multicam angle-switch seeking).
 *  v3 = force LIMITED-range yuv420p (the hardware paths were emitting full-range yuvj420p, which
 *  Chromium's <video> decoder renders black). */
export const PROXY_VERSION = 3
