// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Editor/RippleEngine.swift (GPL-3.0, © Palmier, Inc.)
// Pure functions for ripple editing: how clips shift after insertions or deletions.

import { type Clip, clipEndFrame } from '../model/timeline'

/** A proposed new start frame for a single clip; the caller applies it. */
export interface ClipShift {
  clipId: string
  newStartFrame: number
}

/** A half-open `[start, end)` frame interval on a single track. */
export interface FrameRange {
  start: number
  end: number
}

export function frameRangeLength(r: FrameRange): number {
  return r.end - r.start
}

export interface GapSelection {
  trackIndex: number
  range: FrameRange
}

export function mergeRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged: FrameRange[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) }
    } else {
      merged.push(range)
    }
  }
  return merged
}

/** After removing clips from a track, compute new start frames for remaining clips that
 *  should shift backward to close the gap. */
export function computeRippleShifts(clips: Clip[], removedIds: Set<string>): ClipShift[] {
  const removedRanges = clips
    .filter((c) => removedIds.has(c.id))
    .map((c) => ({ start: c.startFrame, end: clipEndFrame(c) }))
  return computeRippleShiftsForRanges(
    clips.filter((c) => !removedIds.has(c.id)),
    removedRanges
  )
}

/** Shift clips leftward to close the gaps defined by `removedRanges` (may come from another track). */
export function computeRippleShiftsForRanges(clips: Clip[], removedRanges: FrameRange[]): ClipShift[] {
  const merged = mergeRanges(removedRanges)
  if (merged.length === 0) return []

  const shifts: ClipShift[] = []
  const sorted = [...clips].sort((a, b) => a.startFrame - b.startFrame)
  for (const clip of sorted) {
    const shift = merged
      .filter((r) => r.end <= clip.startFrame)
      .reduce((acc, r) => acc + frameRangeLength(r), 0)
    if (shift > 0) {
      shifts.push({ clipId: clip.id, newStartFrame: clip.startFrame - shift })
    }
  }
  return shifts
}

/** Push all clips at or after `insertFrame` forward by `pushAmount` frames. */
export function computeRipplePush(
  clips: Clip[],
  insertFrame: number,
  pushAmount: number,
  excludeIds: Set<string> = new Set()
): ClipShift[] {
  return clips
    .filter((c) => !excludeIds.has(c.id) && c.startFrame >= insertFrame)
    .map((c) => ({ clipId: c.id, newStartFrame: c.startFrame + pushAmount }))
}
