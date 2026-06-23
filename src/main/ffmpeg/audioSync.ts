// SPDX-License-Identifier: GPL-3.0-or-later
// FFmpeg side of multicam audio sync: decode low-rate mono PCM, hand it to the pure DSP in
// @core to recover the inter-camera offset, and extract a video's audio to a standalone file.
// Electron-free (caller passes outDir) so the ffmpeg barrel stays node-testable.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  SYNC_MIN_CONFIDENCE,
  SYNC_MIN_MARGIN,
  crossCorrelateOffset,
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
