// SPDX-License-Identifier: GPL-3.0-or-later
// Pure clipboard placement logic for copy/paste of clips. The clipboard itself lives in the
// renderer (session state, not undoable); these helpers only decide WHAT to store and WHERE a
// paste lands, so they stay node-testable. The actual insertion goes through
// EditorController.insertClips (full-fidelity, one undo step).

import { type Clip, type Timeline } from '../model/timeline'
import { type ClipType, isCompatible } from '../model/clipType'

export interface ClipboardItem {
  /** Deep copy of the clip at copy time (id/linkGroupId re-issued on insert). */
  clip: Clip
  /** Track index at copy time — pasting prefers the same row if it survives. */
  trackIndex: number
  trackType: ClipType
}

export interface ClipboardPayload {
  items: ClipboardItem[]
  /** Earliest startFrame across items: pasting at frame F keeps the block's internal layout by
   *  placing each clip at F + (clip.startFrame − anchorFrame). */
  anchorFrame: number
}

/** Snapshot the selected clips for the clipboard. Returns null when nothing matched. */
export function serializeSelection(tl: Timeline, ids: string[]): ClipboardPayload | null {
  const wanted = new Set(ids)
  const items: ClipboardItem[] = []
  let anchor = Infinity
  tl.tracks.forEach((t, trackIndex) => {
    for (const clip of t.clips) {
      if (!wanted.has(clip.id)) continue
      items.push({ clip: structuredClone(clip), trackIndex, trackType: t.type })
      anchor = Math.min(anchor, clip.startFrame)
    }
  })
  if (items.length === 0) return null
  return { items, anchorFrame: anchor }
}

export interface PastePlacement {
  clip: Clip
  trackId: string
  startFrame: number
}

export interface PasteTargets {
  /** Items that land on tracks that already exist. */
  existing: PastePlacement[]
  /** Items whose original row is gone/incompatible with no fallback — the caller creates one track
   *  per entry (in order) and inserts its items there. */
  needTracks: { trackType: ClipType; items: { clip: Clip; startFrame: number }[] }[]
}

/** Decide where each clipboard item lands when pasted at `atFrame`. Preference order per item:
 *  the original track index (if it survives and is type-compatible) → the first compatible track
 *  top-down → a new track of the item's original track type. Pure; clips are deep-copied again so
 *  repeated pastes never share references. */
export function resolvePasteTargets(tl: Timeline, payload: ClipboardPayload, atFrame: number): PasteTargets {
  const existing: PastePlacement[] = []
  const needTracks = new Map<ClipType, { clip: Clip; startFrame: number }[]>()
  for (const item of payload.items) {
    const startFrame = Math.max(0, Math.round(atFrame + (item.clip.startFrame - payload.anchorFrame)))
    const clip = structuredClone(item.clip)
    const original = tl.tracks[item.trackIndex]
    let targetId: string | null = null
    if (original && isCompatible(original.type, item.clip.mediaType)) {
      targetId = original.id
    } else {
      const fallback = tl.tracks.find((t) => isCompatible(t.type, item.clip.mediaType))
      targetId = fallback?.id ?? null
    }
    if (targetId) {
      existing.push({ clip, trackId: targetId, startFrame })
    } else {
      const list = needTracks.get(item.trackType) ?? []
      list.push({ clip, startFrame })
      needTracks.set(item.trackType, list)
    }
  }
  return {
    existing,
    needTracks: [...needTracks.entries()].map(([trackType, items]) => ({ trackType, items }))
  }
}
