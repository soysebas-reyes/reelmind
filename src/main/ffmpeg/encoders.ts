// SPDX-License-Identifier: GPL-3.0-or-later
// Hardware H.264 encoder detection + per-encoder argument builders, shared by the proxy generator and
// the exporter. An encoder listed in `ffmpeg -encoders` isn't necessarily USABLE (h264_nvenc appears in
// every full build but fails at init without an NVIDIA GPU), so detection runs a tiny real encode per
// candidate and caches the first one that works. On typical machines this is: NVIDIA → h264_nvenc,
// Intel → h264_qsv, AMD (e.g. Ryzen APU) → h264_amf, otherwise libx264.
//
// Why this matters here: camera originals are often 4K 4:2:2 10-bit H.264 — a format consumer GPUs
// CANNOT hardware-decode, so decoding always burns CPU. Moving the ENCODE to the GPU frees those cores
// for the decoder, which is the pipeline's real bottleneck.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ffmpegBinary } from './binary'

const execFileAsync = promisify(execFile)

export type H264Encoder = 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'libx264'

/** Candidates in typical-performance order; libx264 is the always-works floor. */
const HW_CANDIDATES: H264Encoder[] = ['h264_nvenc', 'h264_qsv', 'h264_amf']

async function encoderWorks(encoder: H264Encoder): Promise<boolean> {
  try {
    // 0.2 s of black frames through the real encoder → null sink. Fails fast (~200 ms) when the
    // hardware/driver is absent; succeeds only if the encoder can actually initialize a session.
    await execFileAsync(
      ffmpegBinary(),
      ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=128x128:r=30:d=0.2', '-frames:v', '3', '-c:v', encoder, '-f', 'null', '-'],
      { windowsHide: true, timeout: 10_000 }
    )
    return true
  } catch {
    return false
  }
}

let detected: Promise<H264Encoder> | null = null

/** The best usable H.264 encoder on this machine (detected once per app run, then cached). */
export function detectH264Encoder(): Promise<H264Encoder> {
  if (!detected) {
    detected = (async () => {
      for (const c of HW_CANDIDATES) if (await encoderWorks(c)) return c
      return 'libx264'
    })()
  }
  return detected
}

/** Test seam: override/clear the cached detection. */
export function setDetectedH264Encoder(enc: H264Encoder | null): void {
  detected = enc ? Promise.resolve(enc) : null
}

// ── Proxy (preview) encode args ──────────────────────────────────────────────────────────────────
// Proxy priorities: encode speed > size > fidelity. Constant-QP ~23-24 is visually plenty for a preview.
// GOP 12 (keyframe every ~0.5 s) keeps SEEKING snappy — critical for multicam angle switching, where each
// cut seeks the reappearing angle: a shorter GOP means far fewer frames to decode-forward (g=30 → up to
// ~1.25 s; g=12 → ~0.5 s). `fast_bilinear` downscale and nv12 output shave CPU on the filter side. Bumping
// PROXY_KEYINT invalidates older proxies (see PROXY_VERSION) so they regenerate with the denser GOP.
const PROXY_KEYINT = 12

/** Video filter for the proxy downscale. `out_range=tv` forces LIMITED (broadcast) color range in the
 *  filter graph — encoder-independent, so even hardware encoders (AMF/NVENC/QSV) can't emit full-range
 *  yuvj420p, which Chromium's <video> decoder renders black. hw encoders take nv12 directly (skips a
 *  later conversion); libx264 gets yuv420p. */
export function proxyScaleFilter(encoder: H264Encoder, height: number): string {
  const scale = `scale=-2:${height}:flags=fast_bilinear:out_range=tv`
  return encoder === 'libx264' ? `${scale},format=yuv420p` : `${scale},format=nv12`
}

/** Encoder argument vector for a preview proxy (video side only). */
export function proxyEncodeArgs(encoder: H264Encoder): string[] {
  const g = String(PROXY_KEYINT)
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-rc', 'constqp', '-qp', '24', '-g', g]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '26', '-g', g]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', '-g', g]
    case 'libx264':
      // superfast ≈ 1.4× faster than veryfast at proxy-grade quality; ultrafast bloats files for little gain.
      return ['-c:v', 'libx264', '-preset', 'superfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', g, '-keyint_min', g]
  }
}

// ── Export (deliverable) encode args ─────────────────────────────────────────────────────────────
// Export priorities: fidelity ≥ speed. 'max' always stays libx264 CRF 12 (archival-grade, CPU); the
// other tiers ride the hardware encoder when present — visually transparent for social delivery and
// several times faster, because the CPU is left to the 4:2:2 decode + filter graph.

export type ExportTier = 'high' | 'veryHigh' | 'max'

/** Full video-encoder argument vector for an export (replaces the libx264 crf/preset block). */
export function exportEncodeArgs(encoder: H264Encoder, tier: ExportTier): string[] {
  if (tier === 'max' || encoder === 'libx264') {
    const crf = tier === 'max' ? 12 : tier === 'high' ? 20 : 16
    return ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', 'medium']
  }
  switch (encoder) {
    case 'h264_nvenc': {
      const qp = tier === 'high' ? '22' : '18'
      return ['-c:v', 'h264_nvenc', '-pix_fmt', 'yuv420p', '-preset', 'p5', '-rc', 'constqp', '-qp', qp]
    }
    case 'h264_qsv': {
      const gq = tier === 'high' ? '22' : '18'
      return ['-c:v', 'h264_qsv', '-pix_fmt', 'nv12', '-preset', 'medium', '-global_quality', gq]
    }
    case 'h264_amf': {
      const [qi, qp] = tier === 'high' ? ['21', '23'] : ['17', '19']
      return ['-c:v', 'h264_amf', '-pix_fmt', 'nv12', '-quality', 'quality', '-rc', 'cqp', '-qp_i', qi, '-qp_p', qp]
    }
  }
}
