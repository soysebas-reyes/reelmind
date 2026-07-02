// SPDX-License-Identifier: GPL-3.0-or-later
// ElevenLabs Audio Isolation: upload a clip's audio, get back a voice-isolated version (background
// noise, music, room/reverb removed) and write it as a compact AAC .m4a. This is the ML-grade cleanup
// (Adobe-Podcast / Premiere "Enhance Speech" class) that a DSP filter chain cannot match — it's the
// destructive "clean the source" pass; the per-clip non-destructive `audioEnhance` DSP (EQ/compressor/
// loudness) then shapes tone on top. Mirrors transcript.ts (same xi-api-key + multipart upload pattern).

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { ffmpegBinary } from '../ffmpeg/binary'

const ELEVENLABS_ISOLATION_URL = 'https://api.elevenlabs.io/v1/audio-isolation'

export interface IsolateVoiceOptions {
  /** Dry/wet blend 0..1 (CapCut-style intensity): 1 = fully isolated voice; <1 mixes back some of the
   *  original so the result stays natural instead of sounding "dead"/over-processed. Default 1. */
  intensity?: number
  /** Constant-background reduction 0..1 (kills a steady fan / HVAC / hiss). Mapped to an `afftdn`
   *  (noise-tracking FFT denoiser) pass applied AFTER isolation + blend — so it also removes any fan the
   *  dry blend reintroduced. 0 = off. Default 0. */
  denoise?: number
  /** Live progress line sink for the modal (FFmpeg stderr + coarse stage markers). */
  onLine?: (line: string) => void
}

/** Run ffmpeg `args`, forwarding stderr lines to `onLine`; rejects with the tail of stderr on failure. */
function runFfmpeg(args: string[], onLine?: (line: string) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    let stderr = ''
    let lineBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      if (onLine) {
        lineBuf += chunk
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const ln of lines) if (ln.trim()) onLine(ln)
      }
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n') || `ffmpeg exited ${code}`))
    )
  })
}

/** A SHORT, stable output base for a (possibly already-processed) source. Strips accumulated pipeline
 *  suffixes (`-audio-`/`-enhanced-`/`-isolated-` + a UUID) and caps the length, so re-running isolation
 *  on its own output doesn't grow the filename past Windows' MAX_PATH (~260 chars → ffmpeg "Invalid
 *  argument"). e.g. `C0161-audio-<uuid>-isolated-<uuid>-isolated-<uuid>` → `C0161`. */
function shortBaseName(srcPath: string): string {
  let base = basename(srcPath, extname(srcPath))
  const suffix = /-(?:audio|enhanced|isolated)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  while (suffix.test(base)) base = base.replace(suffix, '')
  return base.slice(0, 40) || 'audio'
}

const AAC_TAIL = ['-ar', '48000', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']

/** Blend the isolated voice (wet) with the original (dry) at `intensity`, then kill a constant
 *  background (fan/HVAC/hiss) with a noise-tracking `afftdn` pass — AFTER the blend, so the fan the dry
 *  signal reintroduces is removed too. Writes 48 kHz stereo AAC to `outPath`. */
async function finalizeIsolated(
  dryPath: string,
  wetPath: string,
  intensity: number,
  denoise: number,
  outPath: string,
  onLine?: (line: string) => void
): Promise<void> {
  const nr = Math.round(8 + denoise * 22) // 0→(off) … 1.0→30 dB of reduction
  const denoiseChain = denoise > 0 ? `highpass=f=80,afftdn=nr=${nr}:nf=-40:tn=1` : ''
  if (intensity >= 0.999) {
    // Pure isolation → optional denoise → standardize.
    await runFfmpeg(['-y', '-i', wetPath, '-af', denoiseChain || 'anull', ...AAC_TAIL, outPath], onLine)
    return
  }
  const wet = intensity.toFixed(3)
  const dry = (1 - intensity).toFixed(3)
  const tail = denoiseChain ? `,${denoiseChain}` : ''
  await runFfmpeg(
    [
      '-y',
      '-i', dryPath,
      '-i', wetPath,
      '-filter_complex',
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${dry}[d];` +
        `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${wet}[w];` +
        `[d][w]amix=inputs=2:normalize=0:dropout_transition=0${tail}[m]`,
      '-map', '[m]',
      ...AAC_TAIL, outPath
    ],
    onLine
  )
}

/** POST a FLAC buffer to ElevenLabs Audio Isolation; returns the isolated audio bytes. */
async function elevenLabsIsolate(flac: Uint8Array, apiKey: string): Promise<Buffer> {
  const form = new FormData()
  form.append('audio', new Blob([new Uint8Array(flac)], { type: 'audio/flac' }), 'audio.flac')
  const res = await fetch(ELEVENLABS_ISOLATION_URL, { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs ${res.status}: ${body}`)
  }
  const cleaned = Buffer.from(await res.arrayBuffer())
  if (cleaned.byteLength === 0) throw new Error('ElevenLabs devolvió audio vacío.')
  return cleaned
}

/**
 * Isolate the voice in `srcPath` via ElevenLabs and write the cleaned audio to a compact AAC `.m4a` in
 * `outDir`; returns the new path. The upload is LOSSLESS (FLAC 48 kHz, channels preserved) — no quality
 * is thrown away before the model. The isolated result is optionally blended with the original
 * (`intensity` < 1) and de-noised (`denoise` > 0). Output is 48 kHz stereo AAC; duration is preserved, so
 * `replaceClipMedia` keeps the clip valid.
 */
export async function isolateVoice(
  srcPath: string,
  apiKey: string,
  outDir: string,
  opts: IsolateVoiceOptions = {}
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 1))
  const denoise = Math.max(0, Math.min(1, opts.denoise ?? 0))
  const uploadPath = join(outDir, `isolate-src-${randomUUID()}.flac`)
  const rawOutPath = join(outDir, `isolate-raw-${randomUUID()}.mp3`)
  const outPath = join(outDir, `${shortBaseName(srcPath)}-isolated-${randomUUID()}.m4a`)
  try {
    // Lossless, full-band upload (FLAC 48 kHz, source channels) so the model gets the best possible input.
    opts.onLine?.('Preparando audio en alta calidad para la IA…')
    await runFfmpeg(['-y', '-i', srcPath, '-vn', '-ar', '48000', '-c:a', 'flac', uploadPath], opts.onLine)

    opts.onLine?.('Aislando la voz con ElevenLabs (IA)… (esto es lo que más tarda)')
    await fs.writeFile(rawOutPath, await elevenLabsIsolate(await fs.readFile(uploadPath), apiKey))

    if (denoise > 0) opts.onLine?.('Reduciendo el ruido de fondo constante (ventilador)…')
    await finalizeIsolated(srcPath, rawOutPath, intensity, denoise, outPath, opts.onLine)
    return outPath
  } finally {
    await fs.rm(uploadPath, { force: true })
    await fs.rm(rawOutPath, { force: true })
  }
}

export interface SnippetPreviewOptions extends IsolateVoiceOptions {
  /** Window start (source seconds) and length to isolate for the modal A/B — keeps the ElevenLabs call
   *  cheap (only a few seconds of audio per "Generar preview"). */
  startSec: number
  durationSec: number
}

/**
 * Isolate just a short window of `srcPath` for the modal preview (so each "Generar preview" only spends
 * a few seconds of ElevenLabs credit). Returns temp paths for BOTH the raw window (the A/B "Original")
 * and the isolated+blended+denoised window (the "Mejorado" base). Caller reads them and cleans them up.
 */
export async function isolateVoiceSnippet(
  srcPath: string,
  apiKey: string,
  opts: SnippetPreviewOptions
): Promise<{ rawPath: string; isolatedPath: string }> {
  const intensity = Math.max(0, Math.min(1, opts.intensity ?? 1))
  const denoise = Math.max(0, Math.min(1, opts.denoise ?? 0))
  const start = Math.max(0, opts.startSec).toFixed(3)
  const dur = Math.max(1, opts.durationSec).toFixed(3)
  const dir = tmpdir()
  const uploadPath = join(dir, `reelmind-aiprev-src-${randomUUID()}.flac`)
  const rawPath = join(dir, `reelmind-aiprev-raw-${randomUUID()}.m4a`)
  const rawOutPath = join(dir, `reelmind-aiprev-iso-${randomUUID()}.mp3`)
  const isolatedPath = join(dir, `reelmind-aiprev-out-${randomUUID()}.m4a`)
  try {
    // Extract the window twice: a lossless FLAC for the model + dry blend, and an m4a for the A/B "Original".
    await runFfmpeg(['-y', '-ss', start, '-i', srcPath, '-t', dur, '-vn', '-ar', '48000', '-c:a', 'flac', uploadPath], opts.onLine)
    await runFfmpeg(['-y', '-ss', start, '-i', srcPath, '-t', dur, '-vn', ...AAC_TAIL, rawPath], opts.onLine)

    await fs.writeFile(rawOutPath, await elevenLabsIsolate(await fs.readFile(uploadPath), apiKey))
    // Dry source for the blend is the extracted window (uploadPath), aligned at 0 with the isolated window.
    await finalizeIsolated(uploadPath, rawOutPath, intensity, denoise, isolatedPath, opts.onLine)
    return { rawPath, isolatedPath }
  } finally {
    await fs.rm(uploadPath, { force: true })
    await fs.rm(rawOutPath, { force: true })
  }
}
