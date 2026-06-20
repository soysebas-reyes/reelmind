// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Timeline/SnapEngine.swift (GPL-3.0, © Palmier, Inc.)
// The upstream haptic-feedback call is intentionally dropped (no macOS dependency).

import { type Track, clipEndFrame } from '../model/timeline'
import { Snap } from '../constants'

export type SnapTargetKind = 'playhead' | 'clipEdge'

export interface SnapTarget {
  frame: number
  kind: SnapTargetKind
}

export interface SnapResult {
  frame: number
  /** Which probe snapped (0 = clip start, durationFrames = clip end). */
  probeOffset: number
  /** Snap indicator pixel position. */
  x: number
}

/** Mutable state that persists across drag events for sticky snap behavior. */
export interface SnapState {
  currentlySnappedTo: number | null
  currentProbeOffset: number
}

export function makeSnapState(): SnapState {
  return { currentlySnappedTo: null, currentProbeOffset: 0 }
}

/** Collect all clip edges, and optionally the playhead, as snap targets. */
export function collectTargets(opts: {
  tracks: Track[]
  playheadFrame?: number
  excludeClipIds?: Set<string>
  includePlayhead?: boolean
}): SnapTarget[] {
  const { tracks, playheadFrame = 0, excludeClipIds = new Set<string>(), includePlayhead = false } = opts
  const targets: SnapTarget[] = []
  if (includePlayhead) targets.push({ frame: playheadFrame, kind: 'playhead' })
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (excludeClipIds.has(clip.id)) continue
      targets.push({ frame: clip.startFrame, kind: 'clipEdge' })
      targets.push({ frame: clipEndFrame(clip), kind: 'clipEdge' })
    }
  }
  return targets
}

/** Snap position(s) to nearest target, with sticky behavior and playhead priority.
 *  `state` is mutated in place (the upstream `inout` parameter). */
export function findSnap(opts: {
  position: number
  probeOffsets?: number[]
  targets: SnapTarget[]
  state: SnapState
  baseThreshold: number
  pixelsPerFrame: number
}): SnapResult | null {
  const { position, probeOffsets = [0], targets, state, baseThreshold, pixelsPerFrame } = opts
  const baseFrameThreshold = baseThreshold / pixelsPerFrame

  // Sticky: stay snapped until moved stickyMultiplier× threshold away.
  if (state.currentlySnappedTo !== null) {
    const snapped = state.currentlySnappedTo
    const holdThreshold = baseFrameThreshold * Snap.stickyMultiplier
    const probePos = position + state.currentProbeOffset
    if (Math.abs(probePos - snapped) <= holdThreshold && targets.some((t) => t.frame === snapped)) {
      return { frame: snapped, probeOffset: state.currentProbeOffset, x: snapped * pixelsPerFrame }
    }
    state.currentlySnappedTo = null
    state.currentProbeOffset = 0
  }

  // Find the closest (probe, target) pair within threshold.
  let best: { probeOffset: number; target: SnapTarget; distance: number } | null = null
  for (const probeOffset of probeOffsets) {
    const probePos = position + probeOffset
    for (const target of targets) {
      const threshold =
        target.kind === 'playhead' ? baseFrameThreshold * Snap.playheadMultiplier : baseFrameThreshold
      const dist = Math.abs(probePos - target.frame)
      if (dist <= threshold && dist < (best?.distance ?? Infinity)) {
        best = { probeOffset, target, distance: dist }
      }
    }
  }

  if (!best) return null
  state.currentlySnappedTo = best.target.frame
  state.currentProbeOffset = best.probeOffset
  return { frame: best.target.frame, probeOffset: best.probeOffset, x: best.target.frame * pixelsPerFrame }
}
