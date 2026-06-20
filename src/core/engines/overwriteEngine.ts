// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Editor/OverwriteEngine.swift (GPL-3.0, © Palmier, Inc.)
// Pure functions for overwrite editing: clearing a region by removing, trimming, or splitting clips.

import { type Clip, clipEndFrame } from '../model/timeline'
import { newId, sround } from '../constants'

export type OverwriteAction =
  | { kind: 'remove'; clipId: string }
  | { kind: 'trimEnd'; clipId: string; newDuration: number }
  | { kind: 'trimStart'; clipId: string; newStartFrame: number; newTrimStart: number; newDuration: number }
  | {
      kind: 'split'
      clipId: string
      leftDuration: number
      rightId: string
      rightStartFrame: number
      rightTrimStart: number
      rightDuration: number
    }

/** Given a region `[regionStart, regionEnd)`, return the actions needed to clear it so a new
 *  clip can be placed there. `makeId` mints the id for the right half of a split. */
export function computeOverwrite(
  clips: Clip[],
  regionStart: number,
  regionEnd: number,
  makeId: () => string = newId
): OverwriteAction[] {
  if (regionEnd <= regionStart) return []
  const actions: OverwriteAction[] = []

  for (const clip of clips) {
    const cs = clip.startFrame
    const ce = clipEndFrame(clip)

    if (ce <= regionStart || cs >= regionEnd) continue

    if (cs >= regionStart && ce <= regionEnd) {
      actions.push({ kind: 'remove', clipId: clip.id })
    } else if (cs < regionStart && ce > regionEnd) {
      const leftDuration = regionStart - cs
      const rightTrimStart = clip.trimStartFrame + sround((regionEnd - cs) * clip.speed)
      const rightDuration = ce - regionEnd
      actions.push({
        kind: 'split',
        clipId: clip.id,
        leftDuration,
        rightId: makeId(),
        rightStartFrame: regionEnd,
        rightTrimStart,
        rightDuration
      })
    } else if (cs < regionStart) {
      // Overlaps left side — trim right edge.
      actions.push({ kind: 'trimEnd', clipId: clip.id, newDuration: regionStart - cs })
    } else {
      // Overlaps right side — trim left edge.
      const newTrimStart = clip.trimStartFrame + sround((regionEnd - cs) * clip.speed)
      actions.push({
        kind: 'trimStart',
        clipId: clip.id,
        newStartFrame: regionEnd,
        newTrimStart,
        newDuration: ce - regionEnd
      })
    }
  }

  return actions
}
