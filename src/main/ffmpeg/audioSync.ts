// SPDX-License-Identifier: GPL-3.0-or-later
// FFmpeg side of multicam audio sync: decode low-rate mono PCM, hand it to the pure DSP in
// @core to recover the inter-camera offset, and extract a video's audio to a standalone file.
// Electron-free (caller passes outDir) so the ffmpeg barrel stays node-testable.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  type AudioEnhanceSettings,
  SYNC_MIN_CONFIDENCE,
  SYNC_MIN_MARGIN,
  buildEnhanceChain,
  crossCorrelateOffset,
  detectIntensityPeaks,
  detectPausesFromEnvelope,
  downsampleEnvelope,
  envelopeRate,
  lagToSeconds,
  rmsEnvelope
} from '../../core'
import { ffmpegBinary, runFfmpegToBuffer } from './binary'

const PCM_RATE = 8000 // mono decode rate; only loudness-over-time matters, so 8 kHz is ample
const ANALYZE_SECONDS = 600 // cap analysis to the first 10 min (~19 MB f32, under the 64 MB buffer cap)

export interface AudioSyncOptions {
  pcmRate?: number
  analyzeSeconds?: number
  maxLagSeconds?: number
}

export interface AudioSyncResult {
  /** B relative to A; positive ⇒ B started later (B must shift left to align onto A). */
  offsetSeconds: number
  offsetFrames: number
  confidence: number
  margin: number
  /** confidence + margin both clear the warn thresholds. */
  reliable: boolean
}

/** Decode the first `analyzeSeconds` of a file to mono f32 PCM at `rate` (Hz) via ffmpeg → Float32Array. */
async function decodeMonoPcm(path: string, rate: number, analyzeSeconds: number): Promise<Float32Array> {
  const buf = await runFfmpegToBuffer([
    '-v',
    'error',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(rate),
    '-t',
    String(analyzeSeconds),
    '-f',
    'f32le',
    'pipe:1'
  ])
  const usableBytes = Math.floor(buf.byteLength / 4) * 4
  if (usableBytes === 0) return new Float32Array(0)
  // Copy to a fresh, 4-byte-aligned ArrayBuffer (a pooled Buffer's byteOffset may be unaligned).
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + usableBytes))
}

/**
 * Recover the time offset between two takes of the same event by cross-correlating their audio
 * loudness envelopes. `fps` (from the timeline) maps the offset to frames. Throws if either file has
 * no decodable audio (callers should also check `probeMedia().hasAudio` for a friendlier message).
 */
export async function computeAudioOffset(
  pathA: string,
  pathB: string,
  fps: number,
  opts: AudioSyncOptions = {}
): Promise<AudioSyncResult> {
  const rate = opts.pcmRate ?? PCM_RATE
  const analyzeSeconds = opts.analyzeSeconds ?? ANALYZE_SECONDS
  const [pcmA, pcmB] = await Promise.all([
    decodeMonoPcm(pathA, rate, analyzeSeconds),
    decodeMonoPcm(pathB, rate, analyzeSeconds)
  ])
  if (pcmA.length === 0 || pcmB.length === 0) {
    throw new Error('No se pudo leer audio de uno de los videos (¿sin pista de audio?).')
  }
  const envOpts = { sampleRate: rate, hopSeconds: 0.01, logCompress: true }
  const fe = envelopeRate(envOpts)
  const envA = rmsEnvelope(pcmA, envOpts)
  const envB = rmsEnvelope(pcmB, envOpts)
  const { lagSamples, confidence, margin } = crossCorrelateOffset(envA, envB, {
    envelopeRate: fe,
    maxLagSeconds: opts.maxLagSeconds ?? 300
  })
  const offsetSeconds = lagToSeconds(lagSamples, fe)
  return {
    offsetSeconds,
    offsetFrames: Math.round(offsetSeconds * fps),
    confidence,
    margin,
    reliable: confidence >= SYNC_MIN_CONFIDENCE && margin >= SYNC_MIN_MARGIN
  }
}

export interface IntensityAnalysis {
  /** Normalized (0..1) loudness envelope, max-pooled to a compact length for drawing. */
  envelope: number[]
  /** Display points per second (envelope length / durationSec). */
  envelopeRate: number
  /** Vocal-emphasis peak times in seconds (dynamic angle-cut candidates). */
  peaks: number[]
  /** Pause midpoint times in seconds (relative-threshold, level-independent — clean cut candidates). */
  pauses: number[]
  /** Decoded audio duration in seconds (capped at the analysis window). */
  durationSec: number
}

/** Decode a file's audio and return its loudness envelope + emphasis peaks + pauses, for the angle-cut
 *  preview. Pure-DSP picking lives in `@core` (edit/peaks); this is the FFmpeg + glue side. Both peaks
 *  and pauses use RELATIVE thresholds derived from this clip's own envelope, so they work on quiet audio. */
export async function analyzeIntensity(path: string, opts: AudioSyncOptions = {}): Promise<IntensityAnalysis> {
  const rate = opts.pcmRate ?? PCM_RATE
  const analyzeSeconds = opts.analyzeSeconds ?? ANALYZE_SECONDS
  const pcm = await decodeMonoPcm(path, rate, analyzeSeconds)
  if (pcm.length === 0) return { envelope: [], envelopeRate: 0, peaks: [], pauses: [], durationSec: 0 }
  const durationSec = pcm.length / rate
  const envOpts = { sampleRate: rate, hopSeconds: 0.02, logCompress: true } // ~50 Hz envelope
  const fe = envelopeRate(envOpts)
  const env = rmsEnvelope(pcm, envOpts)
  const peaks = detectIntensityPeaks(env, { rate: fe, minGapSeconds: 1.2, thresholdK: 1.0, smoothSeconds: 0.15 })
  const pauses = detectPausesFromEnvelope(env, { rate: fe, minDurationSeconds: 0.5, smoothSeconds: 0.15, floorFraction: 0.5 })
  const display = downsampleEnvelope(env, 720)
  return {
    envelope: display,
    envelopeRate: durationSec > 0 ? display.length / durationSec : 0,
    peaks,
    pauses,
    durationSec
  }
}

/**
 * Extract a video's audio to a compact AAC `.m4a` in `outDir`, returning the new file path. The caller
 * then runs it through importMedia to make a bin asset. Re-encodes (not `-c:a copy`) so any source
 * codec works; tiny vs WAV.
 */
export async function extractAudio(videoPath: string, outDir: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const base = basename(videoPath, extname(videoPath))
  const outPath = join(outDir, `${base}-audio-${randomUUID()}.m4a`)
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegBinary(),
      ['-v', 'error', '-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath],
      { windowsHide: true }
    )
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n') || `ffmpeg exited ${code}`))
    })
  })
  return outPath
}

export interface EnhanceAudioOptions extends Partial<AudioEnhanceSettings> {
  /** Live stderr line sink for the progress modal (mirrors silence.ts / transcript.ts). */
  onLine?: (line: string) => void
}

/**
 * Re-render a file's audio through the voice-cleanup chain → compact AAC `.m4a` in `outDir`; returns the
 * new path. Single-pass `loudnorm` (degrades gracefully on near-silent input). Output is STANDARDIZED to
 * 48 kHz stereo so mixed sources line up (and `-ar 48000` undoes loudnorm's internal 192 kHz resample).
 * Mirrors `extractAudio` (windowsHide, AAC 192k, +faststart). Forwards ffmpeg progress via `onLine`.
 */
export async function enhanceAudio(srcPath: string, outDir: string, opts: EnhanceAudioOptions = {}): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const base = basename(srcPath, extname(srcPath))
  const outPath = join(outDir, `${base}-enhanced-${randomUUID()}.m4a`)
  const chain = buildEnhanceChain(opts)
  // No `-v error`/`-nostats` so ffmpeg emits periodic time=/speed= lines for the progress modal.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegBinary(),
      // -ar 48000 -ac 2 standardizes the output format (and undoes loudnorm's 192 kHz internal resample).
      ['-y', '-i', srcPath, '-vn', '-af', chain, '-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outPath],
      { windowsHide: true }
    )
    let stderr = ''
    let lineBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      if (opts.onLine) {
        lineBuf += chunk
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const ln of lines) if (ln.trim()) opts.onLine(ln)
      }
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (opts.onLine && lineBuf.trim()) opts.onLine(lineBuf)
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n') || `ffmpeg exited ${code}`))
    })
  })
  return outPath
}

export interface AudioPreviewOptions {
  /** Source seconds to start the snippet at. */
  startSec: number
  /** Snippet length in seconds (clamped to 1..30). */
  durationSec: number
  settings: AudioEnhanceSettings
}

export interface AudioPreviewClips {
  /** `data:audio/mp4;base64,…` of the unprocessed window (the "A" of the A/B). */
  rawDataUrl: string
  /** `data:audio/mp4;base64,…` of the window through the enhance chain (the "B"). */
  enhancedDataUrl: string
}

/** Render a short snippet to a temp `.m4a` (deleted after reading) and return it as a data URL. */
async function renderSnippetDataUrl(args: (outPath: string) => string[]): Promise<string> {
  const outPath = join(tmpdir(), `reelmind-aprev-${randomUUID()}.m4a`)
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpegBinary(), args(outPath), { windowsHide: true })
      let stderr = ''
      proc.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString()
        if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      })
      proc.on('error', (e) => reject(e))
      proc.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n') || `ffmpeg exited ${code}`))
      )
    })
    const buf = await fs.readFile(outPath)
    return `data:audio/mp4;base64,${buf.toString('base64')}`
  } finally {
    await fs.unlink(outPath).catch(() => {})
  }
}

/** Render two short snippets of `srcPath` — raw and enhanced — for the A/B player in the audio modal.
 *  Returns both as base64 data URLs (no `file://`), mirroring how `color:still` returns a data URL. */
export async function enhanceAudioPreview(srcPath: string, opts: AudioPreviewOptions): Promise<AudioPreviewClips> {
  const ss = Math.max(0, opts.startSec)
  const dur = Math.max(1, Math.min(30, opts.durationSec))
  const chain = buildEnhanceChain(opts.settings)
  const common = ['-v', 'error', '-y', '-ss', String(ss), '-i', srcPath, '-t', String(dur), '-vn']
  const tail = ['-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']
  const [rawDataUrl, enhancedDataUrl] = await Promise.all([
    renderSnippetDataUrl((out) => [...common, ...tail, out]),
    renderSnippetDataUrl((out) => [...common, '-af', chain, ...tail, out])
  ])
  return { rawDataUrl, enhancedDataUrl }
}
