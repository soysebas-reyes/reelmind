// SPDX-License-Identifier: GPL-3.0-or-later
// Pure builder: a Timeline → one FFmpeg `filter_complex` render. Same compositing model as the
// preview (geometry/opacity/z-order), so a render matches what you scrub. No IO — paths come from
// a `resolve(mediaRef)` callback, which keeps this testable without touching disk.
//
// Covered: visual clips (crop, scale-to-transform, position, static opacity, fade in/out, speed,
// timeline placement via overlay enable windows, z-order = track order) and audio clips
// (speed/atempo, volume, delay, mix). Not yet: rotation/flip, text rendering, per-track blend
// modes — flagged for a later pass.

import { colorIsIdentity } from '../model/color'
import { type Clip, type Timeline, clipEndFrame, colorAt, cropIsIdentity, totalFrames } from '../model/timeline'
import { buildColorFilterChain } from './colorFilters'

export interface ExportOptions {
  videoCodec?: string
  audioCodec?: string
  crf?: number
  preset?: string
  audioBitrate?: string
}

export interface ExportGraph {
  /** Full ffmpeg argument vector (excludes the binary name). */
  args: string[]
  filterComplex: string
  inputCount: number
  hasAudio: boolean
  totalFrames: number
  durationSeconds: number
}

function fmt(n: number): string {
  return Number(n.toFixed(6)).toString()
}

function evenRound(v: number): number {
  const r = Math.max(2, Math.round(v))
  return r % 2 === 0 ? r : r + 1
}

/** Decompose a playback-rate into atempo factors, each within ffmpeg's [0.5, 2.0] range. */
export function atempoFilters(speed: number): string[] {
  const out: string[] = []
  let s = speed
  while (s > 2.0 + 1e-9) {
    out.push('atempo=2.0')
    s /= 2
  }
  while (s < 0.5 - 1e-9) {
    out.push('atempo=0.5')
    s *= 2
  }
  if (Math.abs(s - 1) > 1e-9) out.push(`atempo=${fmt(s)}`)
  return out
}

function inputArgsForVisual(clip: Clip, path: string, fps: number): string[] {
  if (clip.mediaType === 'image' || clip.mediaType === 'lottie') {
    const durSec = clip.durationFrames / fps
    return ['-loop', '1', '-framerate', String(fps), '-t', fmt(durSec), '-i', path]
  }
  const trimSec = clip.trimStartFrame / fps
  const srcDurSec = (clip.durationFrames * clip.speed) / fps
  return ['-ss', fmt(trimSec), '-t', fmt(srcDurSec), '-i', path]
}

function inputArgsForAudio(clip: Clip, path: string, fps: number): string[] {
  const trimSec = clip.trimStartFrame / fps
  const srcDurSec = (clip.durationFrames * clip.speed) / fps
  return ['-ss', fmt(trimSec), '-t', fmt(srcDurSec), '-i', path]
}

/** Build the export command. Returns null if the timeline has no resolvable, renderable content. */
export function buildExportGraph(
  timeline: Timeline,
  resolve: (mediaRef: string) => string | null,
  outputPath: string,
  opts: ExportOptions = {},
  resolveLut?: (lutRef: string) => string | null
): ExportGraph | null {
  const fps = timeline.fps
  const W = timeline.width
  const H = timeline.height
  const tf = totalFrames(timeline)
  if (tf <= 0) return null
  const totalSec = tf / fps

  const videoCodec = opts.videoCodec ?? 'libx264'
  const audioCodec = opts.audioCodec ?? 'aac'
  const crf = opts.crf ?? 18
  const preset = opts.preset ?? 'medium'
  const audioBitrate = opts.audioBitrate ?? '192k'

  // Visual clips back-to-front (topmost track index 0 is the foreground → overlaid last).
  const visual: { clip: Clip; path: string }[] = []
  for (let ti = timeline.tracks.length - 1; ti >= 0; ti--) {
    const t = timeline.tracks[ti]
    if (t.type === 'audio' || t.hidden) continue
    for (const clip of t.clips) {
      const p = resolve(clip.mediaRef)
      if (p) visual.push({ clip, path: p })
    }
  }
  const audio: { clip: Clip; path: string }[] = []
  for (const t of timeline.tracks) {
    if (t.type !== 'audio' || t.muted) continue
    for (const clip of t.clips) {
      const p = resolve(clip.mediaRef)
      if (p) audio.push({ clip, path: p })
    }
  }

  if (visual.length === 0 && audio.length === 0) return null

  const inputArgs: string[] = []
  let idx = 0
  const visualIdx = visual.map((v) => {
    inputArgs.push(...inputArgsForVisual(v.clip, v.path, fps))
    return idx++
  })
  const audioIdx = audio.map((a) => {
    inputArgs.push(...inputArgsForAudio(a.clip, a.path, fps))
    return idx++
  })

  const chains: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${fmt(totalSec)}[base]`]

  let prev = '[base]'
  visual.forEach((v, i) => {
    const k = visualIdx[i]
    const c = v.clip
    const startSec = c.startFrame / fps
    const endSec = clipEndFrame(c) / fps
    const rw = evenRound(c.transform.width * W)
    const rh = evenRound(c.transform.height * H)
    const rx = Math.round((c.transform.centerX - c.transform.width / 2) * W)
    const ry = Math.round((c.transform.centerY - c.transform.height / 2) * H)
    const sp = c.speed || 1

    // Head: geometry + timing + alpha-capable pixel format. Tail: opacity + fades (need the alpha).
    const head: string[] = []
    if (!cropIsIdentity(c.crop)) {
      head.push(
        `crop=iw*${fmt(1 - c.crop.left - c.crop.right)}:ih*${fmt(1 - c.crop.top - c.crop.bottom)}:iw*${fmt(c.crop.left)}:ih*${fmt(c.crop.top)}`
      )
    }
    head.push(`scale=${rw}:${rh}`)
    head.push(`setpts=(PTS-STARTPTS)/${fmt(sp)}+${fmt(startSec)}/TB`)
    head.push('format=yuva420p')
    const tail: string[] = []
    if (c.opacity < 1) tail.push(`colorchannelmixer=aa=${fmt(c.opacity)}`)
    if (c.fadeInFrames > 0) tail.push(`fade=t=in:st=${fmt(startSec)}:d=${fmt(c.fadeInFrames / fps)}:alpha=1`)
    if (c.fadeOutFrames > 0) {
      tail.push(`fade=t=out:st=${fmt(endSec - c.fadeOutFrames / fps)}:d=${fmt(c.fadeOutFrames / fps)}:alpha=1`)
    }

    // Color grade (Phase 9.5) sits between head and tail. Identity → emit nothing (byte-identical to an
    // un-graded render). The LUT path comes from resolveLut; a missing LUT is skipped by the chain builder.
    const color = colorAt(c, c.startFrame)
    if (colorIsIdentity(color)) {
      chains.push(`[${k}:v]${[...head, ...tail].join(',')}[v${k}]`)
    } else {
      const lutPath = color.lutRef && resolveLut ? resolveLut(color.lutRef) : null
      const gin = `[gin${k}]`
      const gout = `[gout${k}]`
      chains.push(`[${k}:v]${head.join(',')}${gin}`)
      chains.push(...buildColorFilterChain(color, lutPath, gin, gout))
      chains.push(`${gout}${tail.length > 0 ? tail.join(',') : 'null'}[v${k}]`)
    }
    chains.push(`${prev}[v${k}]overlay=x=${rx}:y=${ry}:enable='between(t,${fmt(startSec)},${fmt(endSec)})':eof_action=pass[ov${k}]`)
    prev = `[ov${k}]`
  })
  chains.push(`${prev}null[vout]`)

  audio.forEach((a, i) => {
    const k = audioIdx[i]
    const c = a.clip
    const startMs = Math.round((c.startFrame / fps) * 1000)
    const filters: string[] = ['asetpts=PTS-STARTPTS', ...atempoFilters(c.speed || 1)]
    if (c.volume !== 1) filters.push(`volume=${fmt(c.volume)}`)
    if (startMs > 0) filters.push(`adelay=${startMs}:all=1`)
    chains.push(`[${k}:a]${filters.join(',')}[a${k}]`)
  })
  const hasAudio = audio.length > 0
  if (audio.length === 1) {
    chains.push(`[a${audioIdx[0]}]anull[aout]`)
  } else if (audio.length > 1) {
    chains.push(`${audioIdx.map((k) => `[a${k}]`).join('')}amix=inputs=${audio.length}:normalize=0:dropout_transition=0[aout]`)
  }

  const maps = ['-map', '[vout]']
  if (hasAudio) maps.push('-map', '[aout]')

  const enc = ['-r', String(fps), '-c:v', videoCodec, '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', preset]
  if (hasAudio) enc.push('-c:a', audioCodec, '-b:a', audioBitrate)
  enc.push('-t', fmt(totalSec))

  const filterComplex = chains.join(';')
  const args = ['-y', ...inputArgs, '-filter_complex', filterComplex, ...maps, ...enc, outputPath]

  return { args, filterComplex, inputCount: idx, hasAudio, totalFrames: tf, durationSeconds: totalSec }
}
