// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Models/Timeline.swift (GPL-3.0, © Palmier, Inc.)
//
// Upstream models these as Swift structs with computed properties + value semantics.
// We model the data as plain JSON-serializable interfaces (for IPC, project files, Immer)
// and the computed properties as pure free functions. Time is integer frames throughout.

import type { ClipType } from './clipType'
import {
  type AnimPair,
  type Interpolation,
  type KeyframeTrack,
  lerpAnimPair,
  lerpNumber,
  sampleTrack,
  smoothstep,
  trackIsActive
} from './keyframe'
import { newId, sround, VolumeScale } from '../constants'

// MARK: - Transform / Crop

/** Clip placement in normalized (0–1) canvas space. rotation in degrees, positive = clockwise. */
export interface Transform {
  centerX: number
  centerY: number
  width: number
  height: number
  rotation: number
  flipHorizontal: boolean
  flipVertical: boolean
}

export function makeTransform(p: Partial<Transform> = {}): Transform {
  return {
    centerX: p.centerX ?? 0.5,
    centerY: p.centerY ?? 0.5,
    width: p.width ?? 1,
    height: p.height ?? 1,
    rotation: p.rotation ?? 0,
    flipHorizontal: p.flipHorizontal ?? false,
    flipVertical: p.flipVertical ?? false
  }
}

export function transformTopLeft(t: Transform): { x: number; y: number } {
  return { x: t.centerX - t.width / 2, y: t.centerY - t.height / 2 }
}

export function transformFromTopLeft(tl: { x: number; y: number }, width: number, height: number): Transform {
  return makeTransform({ centerX: tl.x + width / 2, centerY: tl.y + height / 2, width, height })
}

/** Per-clip crop as edge insets in normalized (0–1) source coordinates. */
export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export function makeCrop(p: Partial<Crop> = {}): Crop {
  return { left: p.left ?? 0, top: p.top ?? 0, right: p.right ?? 0, bottom: p.bottom ?? 0 }
}

export function cropIsIdentity(c: Crop): boolean {
  return c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0
}

export function lerpCrop(a: Crop, b: Crop, t: number): Crop {
  return {
    left: lerpNumber(a.left, b.left, t),
    top: lerpNumber(a.top, b.top, t),
    right: lerpNumber(a.right, b.right, t),
    bottom: lerpNumber(a.bottom, b.bottom, t)
  }
}

// MARK: - Text

export type TextAlignment = 'left' | 'center' | 'right'

/** Minimal text styling for text clips. Expanded in a later phase when text editing lands. */
export interface TextStyle {
  fontName: string
  fontSize: number
  color: string
  alignment: TextAlignment
}

// MARK: - Clip

export interface Clip {
  id: string
  mediaRef: string
  mediaType: ClipType
  sourceClipType: ClipType
  startFrame: number
  durationFrames: number
  trimStartFrame: number
  trimEndFrame: number
  speed: number
  volume: number
  fadeInFrames: number
  fadeOutFrames: number
  fadeInInterpolation: Interpolation
  fadeOutInterpolation: Interpolation
  opacity: number
  transform: Transform
  crop: Crop
  linkGroupId?: string
  captionGroupId?: string
  textContent?: string
  textStyle?: TextStyle
  opacityTrack?: KeyframeTrack<number>
  positionTrack?: KeyframeTrack<AnimPair>
  scaleTrack?: KeyframeTrack<AnimPair>
  rotationTrack?: KeyframeTrack<number>
  cropTrack?: KeyframeTrack<Crop>
  volumeTrack?: KeyframeTrack<number>
}

export interface MakeClipArgs {
  id?: string
  mediaRef: string
  mediaType?: ClipType
  sourceClipType?: ClipType
  startFrame: number
  durationFrames: number
  trimStartFrame?: number
  trimEndFrame?: number
  speed?: number
  volume?: number
}

export function makeClip(a: MakeClipArgs): Clip {
  const mediaType = a.mediaType ?? 'video'
  return {
    id: a.id ?? newId(),
    mediaRef: a.mediaRef,
    mediaType,
    sourceClipType: a.sourceClipType ?? mediaType,
    startFrame: a.startFrame,
    durationFrames: a.durationFrames,
    trimStartFrame: a.trimStartFrame ?? 0,
    trimEndFrame: a.trimEndFrame ?? 0,
    speed: a.speed ?? 1.0,
    volume: a.volume ?? 1.0,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInInterpolation: 'linear',
    fadeOutInterpolation: 'linear',
    opacity: 1.0,
    transform: makeTransform(),
    crop: makeCrop()
  }
}

// MARK: - Clip math (pure derived properties)

/** Frame where this clip ends on the timeline (exclusive). */
export function clipEndFrame(c: Clip): number {
  return c.startFrame + c.durationFrames
}

/** Source frames consumed by the visible portion. */
export function sourceFramesConsumed(c: Clip): number {
  return sround(c.durationFrames * c.speed)
}

/** Total source frames the clip references, including both trims. */
export function sourceDurationFrames(c: Clip): number {
  return sourceFramesConsumed(c) + c.trimStartFrame + c.trimEndFrame
}

/** Half-open containment: [startFrame, endFrame). endFrame belongs to whatever comes next. */
export function clipContains(c: Clip, frame: number): boolean {
  return frame >= c.startFrame && frame < clipEndFrame(c)
}

function keyframeOffset(c: Clip, frame: number): number {
  return frame - c.startFrame
}

/** Authored opacity without the fade envelope. */
export function rawOpacityAt(c: Clip, frame: number): number {
  return sampleTrack(c.opacityTrack, keyframeOffset(c, frame), c.opacity, lerpNumber)
}

export function opacityAt(c: Clip, frame: number): number {
  const base = rawOpacityAt(c, frame)
  if (c.mediaType === 'audio' || (c.fadeInFrames <= 0 && c.fadeOutFrames <= 0)) return base
  return base * fadeMultiplier(c, frame)
}

export function rotationAt(c: Clip, frame: number): number {
  return sampleTrack(c.rotationTrack, keyframeOffset(c, frame), c.transform.rotation, lerpNumber)
}

export function sizeAt(c: Clip, frame: number): { width: number; height: number } {
  const fallback: AnimPair = { a: c.transform.width, b: c.transform.height }
  const s = sampleTrack(c.scaleTrack, keyframeOffset(c, frame), fallback, lerpAnimPair)
  return { width: s.a, height: s.b }
}

export function topLeftAt(c: Clip, frame: number): { x: number; y: number } {
  if (trackIsActive(c.positionTrack)) {
    const p = sampleTrack(c.positionTrack, keyframeOffset(c, frame), { a: 0, b: 0 }, lerpAnimPair)
    return { x: p.a, y: p.b }
  }
  const sz = sizeAt(c, frame)
  return { x: c.transform.centerX - sz.width / 2, y: c.transform.centerY - sz.height / 2 }
}

export function transformAt(c: Clip, frame: number): Transform {
  const tl = topLeftAt(c, frame)
  const sz = sizeAt(c, frame)
  const t = transformFromTopLeft(tl, sz.width, sz.height)
  t.rotation = rotationAt(c, frame)
  t.flipHorizontal = c.transform.flipHorizontal
  t.flipVertical = c.transform.flipVertical
  return t
}

export function cropAt(c: Clip, frame: number): Crop {
  return sampleTrack(c.cropTrack, keyframeOffset(c, frame), c.crop, lerpCrop)
}

/** 0…1 envelope from the fade head/tail ramps. */
export function fadeMultiplier(c: Clip, frame: number): number {
  const rel = frame - c.startFrame
  if (rel < 0 || rel > c.durationFrames) return 0
  const inMul =
    c.fadeInFrames > 0
      ? (() => {
          const t = Math.min(1.0, rel / c.fadeInFrames)
          return c.fadeInInterpolation === 'smooth' ? smoothstep(t) : t
        })()
      : 1.0
  const outRem = c.durationFrames - rel
  const outMul =
    c.fadeOutFrames > 0
      ? (() => {
          const t = Math.min(1.0, outRem / c.fadeOutFrames)
          return c.fadeOutInterpolation === 'smooth' ? smoothstep(t) : t
        })()
      : 1.0
  return Math.min(inMul, outMul)
}

/** Effective linear volume: keyframe envelope (dB) → linear, fade ramp, static volume as outer gain. */
export function volumeAt(c: Clip, frame: number): number {
  const kfGain = trackIsActive(c.volumeTrack)
    ? VolumeScale.linearFromDb(sampleTrack(c.volumeTrack, keyframeOffset(c, frame), 0, lerpNumber))
    : 1.0
  return c.volume * kfGain * fadeMultiplier(c, frame)
}

export function rawVolumeAt(c: Clip, frame: number): number {
  const kfGain = trackIsActive(c.volumeTrack)
    ? VolumeScale.linearFromDb(sampleTrack(c.volumeTrack, keyframeOffset(c, frame), 0, lerpNumber))
    : 1.0
  return c.volume * kfGain
}

/** Clamp a clip's fade ramps so neither exceeds the (current) duration. Mutates in place. */
export function clampFadesToDuration(c: Clip): void {
  const d = Math.max(0, c.durationFrames)
  if (c.fadeInFrames > d) c.fadeInFrames = d
  if (c.fadeOutFrames > d) c.fadeOutFrames = d
  if (c.fadeInFrames < 0) c.fadeInFrames = 0
  if (c.fadeOutFrames < 0) c.fadeOutFrames = 0
}

function clampTrack<V>(track: KeyframeTrack<V> | undefined, duration: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined
  const kept = track.keyframes.filter((k) => k.frame <= duration)
  return kept.length > 0 ? { keyframes: kept } : undefined
}

/** Drop keyframes that fall past the (current) duration on every animatable track. Mutates in place. */
export function clampKeyframesToDuration(c: Clip): void {
  const d = Math.max(0, c.durationFrames)
  c.opacityTrack = clampTrack(c.opacityTrack, d)
  c.positionTrack = clampTrack(c.positionTrack, d)
  c.scaleTrack = clampTrack(c.scaleTrack, d)
  c.rotationTrack = clampTrack(c.rotationTrack, d)
  c.cropTrack = clampTrack(c.cropTrack, d)
  c.volumeTrack = clampTrack(c.volumeTrack, d)
}

/** Set a clip's timeline duration (never below zero) and re-clamp its fades.
 *  Upstream's `Clip.setDuration`. Keyframes are left intact (sampling clamps out-of-range
 *  reads); drop them explicitly with `clampKeyframesToDuration` where needed. Mutates in place. */
export function setClipDuration(c: Clip, duration: number): void {
  c.durationFrames = Math.max(0, duration)
  clampFadesToDuration(c)
}

/** Source-seconds → project-timeline-frame through this clip's placement, trim, and speed. */
export function timelineFrameForSourceSeconds(c: Clip, sourceSeconds: number, fps: number): number | null {
  const sourceFrame = sourceSeconds * fps
  const offsetFromTrim = sourceFrame - c.trimStartFrame
  if (offsetFromTrim < 0) return null
  const frame = sround(c.startFrame + offsetFromTrim / Math.max(c.speed, 0.0001))
  if (frame >= c.startFrame && frame < clipEndFrame(c)) return frame
  return null
}

// MARK: - Track

export interface Track {
  id: string
  type: ClipType
  muted: boolean
  hidden: boolean
  syncLocked: boolean
  clips: Clip[]
}

export function makeTrack(p: { id?: string; type: ClipType; clips?: Clip[] }): Track {
  return {
    id: p.id ?? newId(),
    type: p.type,
    muted: false,
    hidden: false,
    syncLocked: true,
    clips: p.clips ?? []
  }
}

export function trackEndFrame(track: Track): number {
  let maxFrame = 0
  for (const clip of track.clips) maxFrame = Math.max(maxFrame, clipEndFrame(clip))
  return maxFrame
}

/** IDs of clips forming a contiguous chain starting at `fromEnd`, excluding `excludeId`. */
export function contiguousClipIds(track: Track, fromEnd: number, excludeId: string): Set<string> {
  const ids = new Set<string>()
  let chainEnd = fromEnd
  const sorted = [...track.clips].sort((a, b) => a.startFrame - b.startFrame)
  for (const c of sorted) {
    if (c.id === excludeId || c.startFrame < fromEnd) continue
    if (c.startFrame !== chainEnd) break
    chainEnd = clipEndFrame(c)
    ids.add(c.id)
  }
  return ids
}

// MARK: - Timeline

export interface Timeline {
  fps: number
  width: number
  height: number
  settingsConfigured: boolean
  tracks: Track[]
}

export function makeTimeline(p: Partial<Timeline> = {}): Timeline {
  return {
    fps: p.fps ?? 30,
    width: p.width ?? 1920,
    height: p.height ?? 1080,
    settingsConfigured: p.settingsConfigured ?? false,
    tracks: p.tracks ?? []
  }
}

export function totalFrames(timeline: Timeline): number {
  let maxFrame = 0
  for (const track of timeline.tracks) maxFrame = Math.max(maxFrame, trackEndFrame(track))
  return maxFrame
}
