// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Models/Keyframe.swift (GPL-3.0, © Palmier, Inc.)

export type Interpolation = 'linear' | 'hold' | 'smooth'

export interface Keyframe<V> {
  frame: number
  value: V
  interpolationOut: Interpolation
}

export function keyframe<V>(frame: number, value: V, interpolationOut: Interpolation = 'smooth'): Keyframe<V> {
  return { frame, value, interpolationOut }
}

export interface KeyframeTrack<V> {
  keyframes: Keyframe<V>[]
}

export function emptyTrack<V>(keyframes: Keyframe<V>[] = []): KeyframeTrack<V> {
  return { keyframes }
}

export function trackIsActive<V>(track: KeyframeTrack<V> | null | undefined): boolean {
  return !!track && track.keyframes.length > 0
}

/** Insert or replace the keyframe at `kf.frame`, keeping `keyframes` sorted by frame. */
export function kfUpsert<V>(track: KeyframeTrack<V>, kf: Keyframe<V>): void {
  const existing = track.keyframes.findIndex((k) => k.frame === kf.frame)
  if (existing >= 0) {
    track.keyframes[existing] = kf
    return
  }
  const at = track.keyframes.findIndex((k) => k.frame > kf.frame)
  track.keyframes.splice(at === -1 ? track.keyframes.length : at, 0, kf)
}

export function kfRemove<V>(track: KeyframeTrack<V>, frame: number): void {
  track.keyframes = track.keyframes.filter((k) => k.frame !== frame)
}

export function kfMove<V>(track: KeyframeTrack<V>, oldFrame: number, newFrame: number): void {
  const i = track.keyframes.findIndex((k) => k.frame === oldFrame)
  if (i < 0) return
  if (newFrame !== oldFrame && track.keyframes.some((k) => k.frame === newFrame)) return
  const [kf] = track.keyframes.splice(i, 1)
  kf.frame = newFrame
  kfUpsert(track, kf)
}

export function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

export type Interpolate<V> = (a: V, b: V, t: number) => V

/** Sample a value at clip-relative `frame`. Clamps outside the keyframe range; `interpolationOut`
 *  belongs to the left keyframe of each segment. Matches upstream KeyframeTrack.sample. */
export function sampleTrack<V>(
  track: KeyframeTrack<V> | null | undefined,
  frame: number,
  fallback: V,
  interpolate: Interpolate<V>
): V {
  if (!track || track.keyframes.length === 0) return fallback
  const kfs = track.keyframes
  if (kfs.length === 1) return kfs[0].value
  if (frame <= kfs[0].frame) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (frame >= last.frame) return last.value

  const bIdx = kfs.findIndex((k) => k.frame > frame)
  if (bIdx < 0) return last.value
  const a = kfs[bIdx - 1]
  const b = kfs[bIdx]
  const raw = (frame - a.frame) / (b.frame - a.frame)
  switch (a.interpolationOut) {
    case 'hold':
      return a.value
    case 'linear':
      return interpolate(a.value, b.value, raw)
    case 'smooth':
      return interpolate(a.value, b.value, smoothstep(raw))
  }
}

export function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Two-component keyframe value used for position (x, y) and scale (width, height). */
export interface AnimPair {
  a: number
  b: number
}

export function lerpAnimPair(from: AnimPair, to: AnimPair, t: number): AnimPair {
  return { a: lerpNumber(from.a, to.a, t), b: lerpNumber(from.b, to.b, t) }
}

export type AnimatableProperty = 'opacity' | 'position' | 'scale' | 'rotation' | 'crop' | 'volume'
