// SPDX-License-Identifier: GPL-3.0-or-later
// Pure px<->frame layout math for the canvas timeline. CSS-pixel space (the canvas is scaled
// by devicePixelRatio at draw time). Ported in spirit from palmier-pro's TimelineGeometry.

import { type Clip, Defaults } from '@core'

export const HEADER_WIDTH = 108
export const RULER_HEIGHT = 30
export const TRACK_HEIGHT = 66
export const TRACK_PAD = 3
export const TRIM_HANDLE_PX = 8

export interface TimelineLayout {
  pixelsPerFrame: number
  headerWidth: number
  rulerHeight: number
  trackHeight: number
}

export function makeLayout(pixelsPerFrame: number = Defaults.pixelsPerFrame): TimelineLayout {
  return { pixelsPerFrame, headerWidth: HEADER_WIDTH, rulerHeight: RULER_HEIGHT, trackHeight: TRACK_HEIGHT }
}

export function xForFrame(frame: number, l: TimelineLayout, scrollX: number): number {
  return l.headerWidth + frame * l.pixelsPerFrame - scrollX
}

/** Inverse of `xForFrame`, clamped at frame 0. Returns -1 when x is left of the content area. */
export function frameForX(x: number, l: TimelineLayout, scrollX: number): number {
  if (x < l.headerWidth) return -1
  return Math.max(0, Math.round((x - l.headerWidth + scrollX) / l.pixelsPerFrame))
}

export function trackTop(index: number, l: TimelineLayout): number {
  return l.rulerHeight + index * l.trackHeight
}

/** Track index for a y position. Returns -1 for the ruler band, or `trackCount` for below the last track. */
export function trackIndexForY(y: number, l: TimelineLayout, trackCount: number): number {
  if (y < l.rulerHeight) return -1
  const idx = Math.floor((y - l.rulerHeight) / l.trackHeight)
  if (idx >= trackCount) return trackCount
  return idx
}

export interface ClipBox {
  x: number
  y: number
  w: number
  h: number
}

export function clipBox(clip: Clip, trackIndex: number, l: TimelineLayout, scrollX: number): ClipBox {
  return {
    x: xForFrame(clip.startFrame, l, scrollX),
    y: trackTop(trackIndex, l) + TRACK_PAD,
    w: Math.max(1, clip.durationFrames * l.pixelsPerFrame),
    h: l.trackHeight - TRACK_PAD * 2
  }
}

/** Total content width in CSS px for a frame extent (with a little tail padding). */
export function contentWidth(totalFrames: number, l: TimelineLayout): number {
  return l.headerWidth + (totalFrames + Math.round(2 / l.pixelsPerFrame) * l.pixelsPerFrame + 240 / l.pixelsPerFrame) * l.pixelsPerFrame
}

/** Choose a ruler tick spacing (in frames) that renders ~80px apart at the current zoom. */
export function rulerStepFrames(l: TimelineLayout, fps: number): number {
  const targetPx = 90
  const niceSeconds = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  for (const s of niceSeconds) {
    if (s * fps * l.pixelsPerFrame >= targetPx) return s * fps
  }
  return 600 * fps
}
