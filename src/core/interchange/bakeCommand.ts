// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the ffmpeg argument vector that renders ONE baked file for a handoff BakeJob. Pure (no IO):
// the main-process orchestrator resolves the paths + lut and spawns ffmpeg with these args.
//
// It reuses the two canonical chain builders so a baked file matches the app's own preview/export:
//   video grade → buildColorFilterChain (colorFilters.ts)   audio → buildEnhanceChain (audioEnhanceChain.ts)
// Trimming uses the `trim`/`atrim` FILTERS (frame-exact, decode-from-start) rather than input `-ss`,
// mirroring the export graph — input-side seek corrupts the first frame on long-GOP 4K sources.
// Speed ≠ 1 is baked in here (setpts + atempo) so the NLE never needs a fragile time-remap.

import type { AudioEnhanceSettings } from '../model/audioEnhance'
import type { ClipType } from '../model/clipType'
import type { ColorAdjustments } from '../model/color'
import { atempoFilters } from '../export/exportGraph'
import { buildColorFilterChain } from '../export/colorFilters'
import { buildEnhanceChain } from '../model/audioEnhanceChain'
import type { BakeMode } from './bakePlan'

export interface BakeCommandSpec {
  inputPath: string
  outputPath: string
  mode: BakeMode
  mediaType: ClipType
  fps: number
  /** Source frame at baked frame 0. */
  inFrame: number
  /** Source frame (exclusive) at the baked end. */
  outFrame: number
  color?: ColorAdjustments
  /** Resolved absolute .cube path for `color.lutRef`, or null. */
  lutPath?: string | null
  audioEnhance?: AudioEnhanceSettings
  flipH: boolean
  flipV: boolean
  speed: number
  hasAudio: boolean
  crf?: number
  preset?: string
}

function fmt(n: number): string {
  return Number(n.toFixed(6)).toString()
}

/** ffmpeg args (excludes the binary) to render this bake, plus the expected output duration for progress. */
export function buildBakeCommand(spec: BakeCommandSpec): { args: string[]; durationSeconds: number } {
  const {
    inputPath,
    outputPath,
    mode,
    mediaType,
    fps,
    inFrame,
    outFrame,
    color,
    lutPath,
    audioEnhance,
    flipH,
    flipV,
    speed,
    hasAudio
  } = spec
  const crf = spec.crf ?? 16
  const preset = spec.preset ?? 'medium'
  const isAudioOnly = mediaType === 'audio'
  const isImage = mode === 'image'
  const inSec = inFrame / fps
  const outSec = outFrame / fps
  const windowSec = Math.max(0, outSec - inSec)

  const args: string[] = ['-y', '-i', inputPath]
  const fc: string[] = []

  // --- Video (skipped for audio-only sources) ---
  if (!isAudioOnly) {
    const pre: string[] = []
    if (!isImage) {
      pre.push(`trim=start_frame=${Math.round(inFrame)}:end_frame=${Math.round(outFrame)}`)
      pre.push(speed !== 1 ? `setpts=(PTS-STARTPTS)/${fmt(speed)}` : 'setpts=PTS-STARTPTS')
    }
    if (flipH) pre.push('hflip')
    if (flipV) pre.push('vflip')

    if (color) {
      const inL = pre.length > 0 ? '[vpre]' : '[0:v]'
      if (pre.length > 0) fc.push(`[0:v]${pre.join(',')}${inL}`)
      fc.push(...buildColorFilterChain(color, lutPath ?? null, inL, '[vgr]'))
      fc.push(`[vgr]format=yuv420p[vout]`)
    } else {
      fc.push(`[0:v]${[...pre, 'format=yuv420p'].join(',')}[vout]`)
    }
  }

  // --- Audio ---
  const mapAudio = hasAudio
  if (mapAudio) {
    const ap: string[] = []
    if (!isImage) {
      ap.push(`atrim=start=${fmt(inSec)}:end=${fmt(outSec)}`, 'asetpts=PTS-STARTPTS')
      if (speed !== 1) ap.push(...atempoFilters(speed))
    }
    if (audioEnhance) ap.push(buildEnhanceChain(audioEnhance))
    if (ap.length === 0) ap.push('anull')
    fc.push(`[0:a]${ap.join(',')}[aout]`)
  }

  args.push('-filter_complex', fc.join(';'))

  if (!isAudioOnly) args.push('-map', '[vout]')
  if (mapAudio) args.push('-map', '[aout]')

  if (isImage) {
    args.push('-frames:v', '1', '-c:v', 'png', outputPath)
    return { args, durationSeconds: 0 }
  }

  if (!isAudioOnly) {
    args.push('-r', String(fps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(crf), '-preset', preset)
  }
  if (mapAudio) args.push('-c:a', 'aac', '-b:a', '256k')
  args.push('-movflags', '+faststart', outputPath)

  const durationSeconds = speed !== 1 ? windowSec / speed : windowSec
  return { args, durationSeconds }
}
