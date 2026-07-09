// SPDX-License-Identifier: GPL-3.0-or-later
// Refine transcript-derived clean cuts with REAL acoustic silence (from ffmpeg silencedetect, in ms).
// Pure, no IO — the main process decodes the audio and passes the silence ranges here. Three moves:
//  (a) silence cuts (from word gaps) are replaced by the real silences they overlap → excludes breaths /
//      room noise the transcript's gap included, and recovers padding when the real silence is wider;
//  (b) real silences the transcript never marked (intra-sentence pauses) are added as new silence cuts;
//  (c) filler / false-start / repeat cut edges SNAP into an adjacent real silence (within a window), so the
//      cut lands in a muted region — the primary anti-click, complemented by the export micro-fade.
// Aggressive but reviewable: the user vetoes any cut in the preview.

import { type CleanCut, describeCut, mergeCleanCuts } from './transcriptClean'

export interface SilenceMs {
  startMs: number
  endMs: number
}

export interface RefineOptions {
  /** Audio kept inside each real-silence edge (headroom so a cut never bites into speech). Default 40. */
  microPadMs?: number
  /** Minimum length (ms) for an UNMARKED real silence to be added as a new cut. Default 300. */
  minRealSilenceMs?: number
  /** How far (ms) a non-silence cut edge may move to snap into an adjacent real silence. Default 120. */
  snapWindowMs?: number
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean =>
  aStart < bEnd && bStart < aEnd

/** Normalize the silence ranges: drop empty/non-finite, sort, merge overlapping/adjacent. */
function normalizeSilences(silences: SilenceMs[]): SilenceMs[] {
  const clean = silences
    .filter((s) => Number.isFinite(s.startMs) && Number.isFinite(s.endMs) && s.endMs > s.startMs)
    .sort((a, b) => a.startMs - b.startMs)
  const out: SilenceMs[] = []
  for (const s of clean) {
    const last = out[out.length - 1]
    if (last && s.startMs <= last.endMs) last.endMs = Math.max(last.endMs, s.endMs)
    else out.push({ ...s })
  }
  return out
}

/** Refine `cuts` (ms) against real acoustic `silences` (ms). Returns merged, sorted cuts. */
export function refineCutsWithSilence(cuts: CleanCut[], silences: SilenceMs[], opts: RefineOptions = {}): CleanCut[] {
  const microPad = Math.max(0, opts.microPadMs ?? 40)
  const minRealSilence = Math.max(0, opts.minRealSilenceMs ?? 300)
  const snapWindow = Math.max(0, opts.snapWindowMs ?? 120)
  const sil = normalizeSilences(silences)
  if (sil.length === 0) return mergeCleanCuts(cuts)

  /** Shrink a real silence inward by microPad (keep the full range if it's too short to shrink). */
  const shrink = (s: SilenceMs): SilenceMs =>
    s.endMs - s.startMs > 2 * microPad ? { startMs: s.startMs + microPad, endMs: s.endMs - microPad } : { ...s }

  const out: CleanCut[] = []

  for (const cut of cuts) {
    if (cut.kind === 'silencio') {
      // (a) Replace the transcript-gap silence with the REAL silences it overlaps (shrunk).
      const hits = sil.filter((s) => overlaps(cut.startMs, cut.endMs, s.startMs, s.endMs))
      if (hits.length === 0) {
        out.push(cut) // no acoustic silence there — keep the transcript cut (aggressive)
      } else {
        for (const h of hits) {
          const r = shrink(h)
          if (r.endMs > r.startMs) {
            out.push({ startMs: r.startMs, endMs: r.endMs, kind: 'silencio', text: '(silencio)', reason: describeCut('silencio', r.startMs, r.endMs) })
          }
        }
      }
      continue
    }

    // (c) Snap non-silence cut edges into an adjacent real silence so the boundary sits in a muted region.
    let start = cut.startMs
    let end = cut.endMs
    // Start edge: a silence at/just-before start → extend start LEFT into it (swallow leading dead air).
    const sStart = sil.find((s) => s.startMs <= cut.startMs && s.endMs >= cut.startMs - snapWindow)
    if (sStart) start = Math.max(cut.startMs - snapWindow, Math.min(cut.startMs, sStart.startMs + microPad))
    // End edge: a silence at/just-after end → extend end RIGHT into it (swallow trailing dead air).
    const sEnd = sil.find((s) => s.endMs >= cut.endMs && s.startMs <= cut.endMs + snapWindow)
    if (sEnd) end = Math.min(cut.endMs + snapWindow, Math.max(cut.endMs, sEnd.endMs - microPad))
    if (end > start) out.push({ ...cut, startMs: start, endMs: end })
    else out.push(cut)
  }

  // (b) Add real silences the transcript never marked (intra-sentence pauses), long enough to matter.
  for (const s of sil) {
    const overlapsAnyCut = cuts.some((c) => overlaps(c.startMs, c.endMs, s.startMs, s.endMs))
    if (overlapsAnyCut) continue
    const r = shrink(s)
    if (r.endMs - r.startMs >= minRealSilence) {
      out.push({ startMs: r.startMs, endMs: r.endMs, kind: 'silencio', text: '(silencio)', reason: describeCut('silencio', r.startMs, r.endMs) })
    }
  }

  return mergeCleanCuts(out)
}
