// SPDX-License-Identifier: GPL-3.0-or-later
// Pure builder: a Timeline → one FFmpeg `filter_complex` render. Same compositing model as the
// preview (geometry/opacity/z-order), so a render matches what you scrub. No IO — paths come from
// a `resolve(mediaRef)` callback, which keeps this testable without touching disk.
//
// Covered: visual clips (crop, scale-to-transform, position, static opacity, fade in/out, speed,
// timeline placement via overlay enable windows, z-order = track order) and audio clips
// (speed/atempo, volume, delay, mix). Not yet: rotation/flip, text rendering, per-track blend
// modes — flagged for a later pass.

import { audioEnhanceIsIdentity } from '../model/audioEnhance'
import { buildEnhanceChain } from '../model/audioEnhanceChain'
import { colorIsIdentity } from '../model/color'
import { trackIsActive } from '../model/keyframe'
import { type Clip, type Timeline, clipEndFrame, colorAt, cropIsIdentity, sourceFramesConsumed, totalFrames } from '../model/timeline'
import { buildColorFilterChain } from './colorFilters'

/** A visual clip that can never contribute pixels — opacity pinned at 0 with no opacity keyframes to
 *  lift it. Non-destructive multicam angle-cuts leave the HIDDEN angle's segments exactly like this
 *  (opacity 0, still on the timeline). The preview already skips them (composeFrame); the export must
 *  too, or every hidden segment wastes a decode + scale + lut3d + overlay and the filtergraph OOMs. */
function isInvisible(c: Clip): boolean {
  return c.opacity <= 0 && !trackIsActive(c.opacityTrack)
}

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
      if (isInvisible(clip)) continue // hidden multicam angle (opacity 0) — skip so the graph doesn't OOM
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

  // --- Inputs: DEDUP streamed sources (video/audio) to a single `-i` each; each clip's segment is then
  // carved from the shared decoded stream with trim/atrim (+ split/asplit to fan a source out to its
  // clips). A multicam timeline has dozens of clips but only 2-3 sources — one `-i` per clip previously
  // spawned 20+ simultaneous H.264 decoders and OOM'd the export ("Cannot allocate memory" + filter
  // reinit). Decoding from the start and trimming also avoids the "corrupt decoded frame" that input-side
  // `-ss` caused on long-GOP 4K sources. Images/lottie keep a per-clip looped input (they need -loop/-t). */
  const inputArgs: string[] = []
  let idx = 0
  const streamedInputIdx = new Map<string, number>()
  const streamedInput = (path: string): number => {
    let i = streamedInputIdx.get(path)
    if (i === undefined) {
      i = idx++
      streamedInputIdx.set(path, i)
      inputArgs.push('-i', path)
    }
    return i
  }

  const visualEntries = visual.map(({ clip, path }) => {
    if (clip.mediaType === 'image' || clip.mediaType === 'lottie') {
      const i = idx++
      inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', fmt(clip.durationFrames / fps), '-i', path)
      return { clip, inputIdx: i, looped: true }
    }
    return { clip, inputIdx: streamedInput(path), looped: false }
  })
  const audioEntries = audio.map(({ clip, path }) => ({ clip, inputIdx: streamedInput(path) }))

  const chains: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${fmt(totalSec)}[base]`]

  // Shared colour grade per streamed input: when EVERY visible clip of one source carries the same
  // non-identity grade (the multicam case — one preset per angle, applied to all its segments), grade
  // the source ONCE before the split instead of once per segment. This collapses N lut3d/split+blend
  // instances (each loading the .cube; the Guillermo presets use lutIntensity 0.5 → split+blend) down
  // to one per source — the biggest memory win on a heavily-cut multicam timeline. Only kicks in with
  // ≥2 segments of the source so single-clip renders keep their exact (golden-tested) per-clip chain.
  const sharedGrade = new Map<number, { color: ReturnType<typeof colorAt>; lutPath: string | null }>()
  {
    const byInput = new Map<number, Clip[]>()
    for (const e of visualEntries) {
      if (e.looped) continue
      const arr = byInput.get(e.inputIdx)
      if (arr) arr.push(e.clip)
      else byInput.set(e.inputIdx, [e.clip])
    }
    for (const [inIdx, clips] of byInput) {
      if (clips.length < 2) continue
      const first = colorAt(clips[0], clips[0].startFrame)
      if (colorIsIdentity(first)) continue
      const key = JSON.stringify(first)
      if (!clips.every((c) => JSON.stringify(colorAt(c, c.startFrame)) === key)) continue
      sharedGrade.set(inIdx, { color: first, lutPath: first.lutRef && resolveLut ? resolveLut(first.lutRef) : null })
    }
  }

  // Fan each shared VIDEO input out to one branch per clip using it; single-consumer inputs are used
  // directly. When a source has a shared grade, grade it once here (before the split). Branches are
  // handed out in clip order via shift().
  const videoConsumers = new Map<number, number>()
  for (const e of visualEntries) if (!e.looped) videoConsumers.set(e.inputIdx, (videoConsumers.get(e.inputIdx) ?? 0) + 1)
  const videoBranches = new Map<number, string[]>()
  for (const [inIdx, n] of videoConsumers) {
    let base = `[${inIdx}:v]`
    const sg = sharedGrade.get(inIdx)
    if (sg) {
      const gl = `[gsrc${inIdx}]`
      chains.push(...buildColorFilterChain(sg.color, sg.lutPath, base, gl))
      base = gl
    }
    if (n <= 1) {
      videoBranches.set(inIdx, [base])
    } else {
      const labels = Array.from({ length: n }, (_, j) => `[sv${inIdx}_${j}]`)
      chains.push(`${base}split=${n}${labels.join('')}`)
      videoBranches.set(inIdx, labels)
    }
  }

  let prev = '[base]'
  visualEntries.forEach((e, i) => {
    const c = e.clip
    const k = i // per-clip chain id
    const startSec = c.startFrame / fps
    const endSec = clipEndFrame(c) / fps
    const rw = evenRound(c.transform.width * W)
    const rh = evenRound(c.transform.height * H)
    const rx = Math.round((c.transform.centerX - c.transform.width / 2) * W)
    const ry = Math.round((c.transform.centerY - c.transform.height / 2) * H)
    const sp = c.speed || 1
    const src = e.looped ? `[${e.inputIdx}:v]` : (videoBranches.get(e.inputIdx)!.shift() as string)

    // Head: carve source window (video) → geometry → timing. NO pixel-format conversion here: the colour
    // grade (lut3d/curves/blend) runs next and, if handed an ALPHA channel, forces an UNACCELERATED
    // `yuva420p→gbrap` swscale path that balloons memory and crashes the render ("Cannot allocate
    // memory"). So alpha is introduced AFTER the grade, and ONLY for clips that actually need it
    // (opacity/fades). setsar=1 keeps every overlay input uniform so the graph never reinitializes on a
    // source with a different SAR.
    const head: string[] = []
    if (!e.looped) {
      const srcStart = c.trimStartFrame / fps
      const srcEnd = (c.trimStartFrame + sourceFramesConsumed(c)) / fps
      head.push(`trim=start=${fmt(srcStart)}:end=${fmt(srcEnd)}`)
    }
    if (!cropIsIdentity(c.crop)) {
      head.push(
        `crop=iw*${fmt(1 - c.crop.left - c.crop.right)}:ih*${fmt(1 - c.crop.top - c.crop.bottom)}:iw*${fmt(c.crop.left)}:ih*${fmt(c.crop.top)}`
      )
    }
    head.push(`scale=${rw}:${rh}`, 'setsar=1')
    head.push(`setpts=(PTS-STARTPTS)/${fmt(sp)}+${fmt(startSec)}/TB`)

    // Tail: add the alpha channel (post-grade) only when the clip needs it; otherwise normalize to a
    // plain yuv420p so overlay inputs stay uniform and no needless alpha buffers are allocated.
    const needsAlpha = c.opacity < 1 || c.fadeInFrames > 0 || c.fadeOutFrames > 0
    const tail: string[] = []
    if (needsAlpha) {
      tail.push('format=yuva420p')
      if (c.opacity < 1) tail.push(`colorchannelmixer=aa=${fmt(c.opacity)}`)
      if (c.fadeInFrames > 0) tail.push(`fade=t=in:st=${fmt(startSec)}:d=${fmt(c.fadeInFrames / fps)}:alpha=1`)
      if (c.fadeOutFrames > 0) {
        tail.push(`fade=t=out:st=${fmt(endSec - c.fadeOutFrames / fps)}:d=${fmt(c.fadeOutFrames / fps)}:alpha=1`)
      }
    } else {
      tail.push('format=yuv420p')
    }

    // Color grade (Phase 9.5) sits between head and tail. Identity → emit nothing (byte-identical to an
    // un-graded render). The LUT path comes from resolveLut; a missing LUT is skipped by the chain builder.
    // If this source was graded once before the split (sharedGrade), the branch is already graded → skip.
    const color = colorAt(c, c.startFrame)
    const preGraded = !e.looped && sharedGrade.has(e.inputIdx)
    if (preGraded || colorIsIdentity(color)) {
      chains.push(`${src}${[...head, ...tail].join(',')}[v${k}]`)
    } else {
      const lutPath = color.lutRef && resolveLut ? resolveLut(color.lutRef) : null
      const gin = `[gin${k}]`
      const gout = `[gout${k}]`
      chains.push(`${src}${head.join(',')}${gin}`)
      chains.push(...buildColorFilterChain(color, lutPath, gin, gout))
      chains.push(`${gout}${tail.join(',')}[v${k}]`)
    }
    chains.push(`${prev}[v${k}]overlay=x=${rx}:y=${ry}:enable='between(t,${fmt(startSec)},${fmt(endSec)})':eof_action=pass[ov${k}]`)
    prev = `[ov${k}]`
  })
  chains.push(`${prev}null[vout]`)

  // Audio: dedup sources too; carve each clip with atrim from a shared (asplit) stream.
  const audioConsumers = new Map<number, number>()
  for (const e of audioEntries) audioConsumers.set(e.inputIdx, (audioConsumers.get(e.inputIdx) ?? 0) + 1)
  const audioBranches = new Map<number, string[]>()
  for (const [inIdx, n] of audioConsumers) {
    if (n <= 1) {
      audioBranches.set(inIdx, [`[${inIdx}:a]`])
    } else {
      const labels = Array.from({ length: n }, (_, j) => `[sa${inIdx}_${j}]`)
      chains.push(`[${inIdx}:a]asplit=${n}${labels.join('')}`)
      audioBranches.set(inIdx, labels)
    }
  }

  const audioOutLabels: string[] = []
  audioEntries.forEach((e, i) => {
    const c = e.clip
    const k = i
    const startMs = Math.round((c.startFrame / fps) * 1000)
    const srcStart = c.trimStartFrame / fps
    const srcEnd = (c.trimStartFrame + sourceFramesConsumed(c)) / fps
    const src = audioBranches.get(e.inputIdx)!.shift() as string
    const filters: string[] = [`atrim=start=${fmt(srcStart)}:end=${fmt(srcEnd)}`, 'asetpts=PTS-STARTPTS', ...atempoFilters(c.speed || 1)]
    if (c.volume !== 1) filters.push(`volume=${fmt(c.volume)}`)
    // Non-destructive voice/loudness enhancement (the exact chain the live preview approximates). Skipped
    // when disabled/identity so the render stays byte-identical to an un-enhanced one.
    if (!audioEnhanceIsIdentity(c.audioEnhance)) filters.push(buildEnhanceChain(c.audioEnhance))
    if (startMs > 0) filters.push(`adelay=${startMs}:all=1`)
    chains.push(`${src}${filters.join(',')}[a${k}]`)
    audioOutLabels.push(`[a${k}]`)
  })
  const hasAudio = audioOutLabels.length > 0
  if (audioOutLabels.length === 1) {
    chains.push(`${audioOutLabels[0]}anull[aout]`)
  } else if (audioOutLabels.length > 1) {
    chains.push(`${audioOutLabels.join('')}amix=inputs=${audioOutLabels.length}:normalize=0:dropout_transition=0[aout]`)
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
