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
  /** Full video-encoder argument vector (e.g. hardware encoders whose rate control isn't crf/preset).
   *  When set, it REPLACES the `-c:v/-pix_fmt/-crf/-preset` block; videoCodec/crf/preset are ignored. */
  videoEncoderArgs?: string[]
}

export interface ExportGraph {
  /** Full ffmpeg argument vector (excludes the binary name). */
  args: string[]
  filterComplex: string
  inputCount: number
  hasAudio: boolean
  totalFrames: number
  durationSeconds: number
  /** How the visual stack was assembled: 'concat' = memory-safe sequential fast path;
   *  'overlay' = general compositing (per-clip overlay chain). Surfaced for export diagnostics. */
  videoMode: 'concat' | 'overlay' | 'none'
  /** Visible visual/audio clip counts that made it into the graph (post invisible-skip). */
  visualClipCount: number
  audioClipCount: number
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

  const chains: string[] = []

  // Shared colour grade per streamed input: when EVERY visible clip of one source carries the same
  // non-identity grade (the multicam case — one preset per angle, applied to all its segments), grade
  // the source ONCE before the split instead of once per segment. This collapses N lut3d/split+blend
  // instances (each loading the .cube; the Guillermo presets use lutIntensity 0.5 → split+blend) down
  // to one per source — a big memory win on a heavily-cut multicam timeline. Only kicks in with ≥2
  // segments of the source so single-clip renders keep their exact (golden-tested) per-clip chain.
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

  // A clip that fills the whole frame with the default transform → can be scaled once at the source and
  // stitched into a flat `concat` sequence instead of positioned with `overlay`.
  const isFullFrame = (c: Clip): boolean =>
    cropIsIdentity(c.crop) &&
    c.transform.width === 1 &&
    c.transform.height === 1 &&
    c.transform.centerX === 0.5 &&
    c.transform.centerY === 0.5 &&
    c.transform.rotation === 0 &&
    !c.transform.flipHorizontal &&
    !c.transform.flipVertical

  // FAST PATH — a pure sequence: every visible clip is full-frame + fully opaque and no two overlap in
  // time (the multicam result after angle-cuts + "Cerrar huecos"). A base+overlay chain here is fatal:
  // each time-shifted overlay input stalls framesync so the graph buffers O(N²) frames and dies with
  // "Cannot allocate memory" at frame 0 (reproduced at ~60 clips @1080p), and one scale per segment
  // compounds it. Instead scale each SOURCE once, carve each segment with trim, and stitch with `concat`
  // (+ black gaps) → linear memory even for hundreds of cuts. Fades become fade-to-black (nothing sits
  // beneath a single sequence). Anything with overlap / PIP / partial opacity falls to the overlay path.
  const sortedVisual = [...visualEntries].sort((a, b) => a.clip.startFrame - b.clip.startFrame)
  const noOverlap = sortedVisual.every((e, i) => i === 0 || clipEndFrame(sortedVisual[i - 1].clip) <= e.clip.startFrame)
  const pureSequence =
    visualEntries.length >= 2 && // a single clip never OOMs; keep it on the (simpler) overlay path
    noOverlap &&
    visualEntries.every((e) => isFullFrame(e.clip) && e.clip.opacity === 1 && !trackIsActive(e.clip.opacityTrack))

  if (pureSequence) {
    // Scale (+ shared-grade) each streamed source ONCE, then fan out one trim branch per segment.
    const consumers = new Map<number, number>()
    for (const e of visualEntries) if (!e.looped) consumers.set(e.inputIdx, (consumers.get(e.inputIdx) ?? 0) + 1)
    const branches = new Map<number, string[]>()
    const preGradedInputs = new Set<number>()
    for (const [inIdx, n] of consumers) {
      let base = `[psc${inIdx}]`
      chains.push(`[${inIdx}:v]scale=${W}:${H},setsar=1${base}`)
      const sg = sharedGrade.get(inIdx)
      if (sg) {
        const gl = `[pg${inIdx}]`
        chains.push(...buildColorFilterChain(sg.color, sg.lutPath, base, gl))
        const gf = `[pgf${inIdx}]`
        chains.push(`${gl}format=yuv420p${gf}`) // back to plain yuv after the grade (no alpha in a flat sequence)
        base = gf
        preGradedInputs.add(inIdx)
      }
      if (n <= 1) {
        branches.set(inIdx, [base])
      } else {
        const labels = Array.from({ length: n }, (_, j) => `[sv${inIdx}_${j}]`)
        chains.push(`${base}split=${n}${labels.join('')}`)
        branches.set(inIdx, labels)
      }
    }

    const pieces: string[] = []
    let cursor = 0
    let gapId = 0
    let k = 0
    for (const e of sortedVisual) {
      const c = e.clip
      if (c.startFrame > cursor) {
        const gl = `[gap${gapId++}]`
        chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${fmt((c.startFrame - cursor) / fps)},setsar=1,format=yuv420p${gl}`)
        pieces.push(gl)
      }
      const sp = c.speed || 1
      const segDur = c.durationFrames / fps
      const src = e.looped ? `[${e.inputIdx}:v]` : (branches.get(e.inputIdx)!.shift() as string)

      // Head resets the segment to PTS 0 (concat sequences segments back-to-back). Sources are already
      // scaled at the branch; looped images/lottie carry their own -loop/-t input, so scale them here.
      const head: string[] = []
      if (!e.looped) {
        const srcStart = c.trimStartFrame / fps
        const srcEnd = (c.trimStartFrame + sourceFramesConsumed(c)) / fps
        head.push(`trim=start=${fmt(srcStart)}:end=${fmt(srcEnd)}`)
      } else {
        head.push(`scale=${W}:${H}`, 'setsar=1')
      }
      head.push(`setpts=(PTS-STARTPTS)/${fmt(sp)}`)

      // Fades collapse to fade-to-black (no layer beneath a single sequence). Timing is segment-relative.
      const tail: string[] = []
      if (c.fadeInFrames > 0) tail.push(`fade=t=in:st=0:d=${fmt(c.fadeInFrames / fps)}`)
      if (c.fadeOutFrames > 0) tail.push(`fade=t=out:st=${fmt(segDur - c.fadeOutFrames / fps)}:d=${fmt(c.fadeOutFrames / fps)}`)
      tail.push('format=yuv420p')

      const color = colorAt(c, c.startFrame)
      const preGraded = !e.looped && preGradedInputs.has(e.inputIdx)
      const seg = `[seg${k}]`
      if (preGraded || colorIsIdentity(color)) {
        chains.push(`${src}${[...head, ...tail].join(',')}${seg}`)
      } else {
        const lutPath = color.lutRef && resolveLut ? resolveLut(color.lutRef) : null
        const gin = `[cin${k}]`
        const gout = `[cout${k}]`
        chains.push(`${src}${head.join(',')}${gin}`)
        chains.push(...buildColorFilterChain(color, lutPath, gin, gout))
        chains.push(`${gout}${tail.join(',')}${seg}`)
      }
      pieces.push(seg)
      cursor = c.startFrame + c.durationFrames
      k++
    }
    if (cursor < tf) {
      const gl = `[gap${gapId++}]`
      chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${fmt((tf - cursor) / fps)},setsar=1,format=yuv420p${gl}`)
      pieces.push(gl)
    }
    chains.push(`${pieces.join('')}concat=n=${pieces.length}:v=1:a=0[vout]`)
  } else {
    // OVERLAY PATH — general compositing for overlaps / PIP / partial opacity. Base black + one overlay
    // per clip, each positioned and time-windowed. (Bounded clip counts; the fast path above handles the
    // large sequential-multicam case that would otherwise OOM here.)
    chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${fmt(totalSec)}[base]`)

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
      // `yuva420p→gbrap` swscale path that balloons memory. So alpha is introduced AFTER the grade, and
      // ONLY for clips that need it (opacity/fades). setsar=1 keeps overlay inputs uniform.
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
  }

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
    // Anti-click micro-fade at each clip edge (clean-take timelines only): every audio seam there is a
    // real cut, so an ~8ms in/out fade removes the pop. `st` is on the clip's own 0-based stream (post
    // atempo, pre adelay). Clamped for very short cut fragments so the two fades never overlap.
    if (timeline.antiClickAudioFades) {
      const outDur = c.durationFrames / fps
      const d = Math.min(0.008, outDur / 2)
      if (d > 0) {
        filters.push(`afade=t=in:st=0:d=${fmt(d)}`)
        filters.push(`afade=t=out:st=${fmt(outDur - d)}:d=${fmt(d)}`)
      }
    }
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

  const enc = [
    '-r',
    String(fps),
    ...(opts.videoEncoderArgs ?? ['-c:v', videoCodec, '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', preset])
  ]
  if (hasAudio) enc.push('-c:a', audioCodec, '-b:a', audioBitrate)
  enc.push('-t', fmt(totalSec))

  const filterComplex = chains.join(';')
  const args = ['-y', ...inputArgs, '-filter_complex', filterComplex, ...maps, ...enc, outputPath]

  return {
    args,
    filterComplex,
    inputCount: idx,
    hasAudio,
    totalFrames: tf,
    durationSeconds: totalSec,
    videoMode: visualEntries.length === 0 ? 'none' : pureSequence ? 'concat' : 'overlay',
    visualClipCount: visualEntries.length,
    audioClipCount: audioEntries.length
  }
}
