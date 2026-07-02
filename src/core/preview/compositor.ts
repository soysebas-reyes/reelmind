// SPDX-License-Identifier: GPL-3.0-or-later
// Pure frame compositor: given a timeline and a frame, resolve the ordered visual layers and
// audio gains to render. This is the shared truth that both the real-time preview (P3) and the
// FFmpeg export graph (P4) build on, so they stay consistent. No framework, no IO.

import type { ClipType } from '../model/clipType'
import {
  type Clip,
  type Crop,
  type Timeline,
  type Transform,
  clipContains,
  cropAt,
  cropIsIdentity,
  opacityAt,
  transformAt,
  volumeAt
} from '../model/timeline'

export interface VisualLayer {
  clipId: string
  mediaRef: string
  mediaType: ClipType
  trackIndex: number
  transform: Transform
  opacity: number
  crop: Crop
  /** Source media time (seconds) to display for this clip at the requested frame. */
  sourceSeconds: number
  textContent?: string
}

export interface AudioLayer {
  clipId: string
  mediaRef: string
  trackIndex: number
  /** Effective linear gain (static volume × keyframe envelope × fade). */
  gain: number
  sourceSeconds: number
}

export interface ComposedFrame {
  frame: number
  width: number
  height: number
  fps: number
  /** Visual layers in back-to-front draw order (draw index 0 first, last on top). */
  visual: VisualLayer[]
  audio: AudioLayer[]
}

/** Source media time (seconds) shown for a clip at a given timeline frame. */
export function clipSourceSecondsAt(clip: Clip, frame: number, fps: number): number {
  const sourceFrame = clip.trimStartFrame + (frame - clip.startFrame) * clip.speed
  return sourceFrame / Math.max(1, fps)
}

/** Resolve everything needed to render `frame`. Visual tracks render with the topmost track
 *  (index 0) as the foreground; audio sums across non-muted audio tracks. */
export function composeFrame(timeline: Timeline, frame: number): ComposedFrame {
  const visual: VisualLayer[] = []
  const audio: AudioLayer[] = []

  // Iterate from the last track to the first so the foreground (track 0) ends up last in the
  // draw list (drawn on top).
  for (let ti = timeline.tracks.length - 1; ti >= 0; ti--) {
    const track = timeline.tracks[ti]

    if (track.type === 'audio') {
      if (track.muted) continue
      for (const clip of track.clips) {
        if (!clipContains(clip, frame)) continue
        audio.push({
          clipId: clip.id,
          mediaRef: clip.mediaRef,
          trackIndex: ti,
          gain: volumeAt(clip, frame),
          sourceSeconds: clipSourceSecondsAt(clip, frame, timeline.fps)
        })
      }
      continue
    }

    if (track.hidden) continue
    for (const clip of track.clips) {
      if (!clipContains(clip, frame)) continue
      const opacity = opacityAt(clip, frame)
      if (opacity <= 0) continue
      visual.push({
        clipId: clip.id,
        mediaRef: clip.mediaRef,
        mediaType: clip.mediaType,
        trackIndex: ti,
        transform: transformAt(clip, frame),
        opacity,
        crop: cropAt(clip, frame),
        sourceSeconds: clipSourceSecondsAt(clip, frame, timeline.fps),
        textContent: clip.textContent
      })
    }
  }

  audio.sort((a, b) => a.trackIndex - b.trackIndex)
  return { frame, width: timeline.width, height: timeline.height, fps: timeline.fps, visual, audio }
}

/** True when a visual layer covers the whole frame opaquely, so every layer beneath it is hidden.
 *  Full-frame = no rotation, normalized size ≥ 1, centered, uncropped, effectively opaque.
 *  (flip flags don't affect coverage.) */
export function layerFullyOccludes(l: VisualLayer): boolean {
  const t = l.transform
  return (
    l.opacity >= 0.999 &&
    t.rotation === 0 &&
    t.width >= 1 &&
    t.height >= 1 &&
    Math.abs(t.centerX - 0.5) < 1e-6 &&
    Math.abs(t.centerY - 0.5) < 1e-6 &&
    cropIsIdentity(l.crop)
  )
}

/** The set of `mediaRef`s that actually contribute pixels at this frame: everything from the topmost
 *  full-frame opaque occluder upward. `visual` is back-to-front (last = on top), so scan from the end.
 *  Lets the preview decode/draw only the visible angle when one fully covers another (multicam stack),
 *  and re-include both automatically once a cut makes them partially visible. */
export function visibleLayerSet(visual: VisualLayer[]): Set<string> {
  let firstVisibleIdx = 0
  for (let i = visual.length - 1; i >= 0; i--) {
    if (layerFullyOccludes(visual[i])) {
      firstVisibleIdx = i
      break
    }
  }
  const refs = new Set<string>()
  for (let i = firstVisibleIdx; i < visual.length; i++) refs.add(visual[i].mediaRef)
  return refs
}
