// SPDX-License-Identifier: GPL-3.0-or-later
// Pure transcript-based multicam alignment: recover the time offset between two angles by matching the
// WORDS they both spoke. Far more precise than RMS cross-correlation when there is speech, because word
// timestamps are exact landmarks. Robust via offset "voting" (a 1-D Hough): every same-word pair casts a
// vote for an offset; the modal bin is the true global offset. Optional intensity peaks up-weight loud,
// clearly-articulated words (more reliable timestamps). No IO.

import { normalizeToken } from './transcriptClean'

export interface AlignWord {
  text: string
  startMs: number
  endMs: number
  type?: 'word' | 'spacing' | 'audio_event'
}

export interface AlignOptions {
  /** Vote bin width (ms). Default 60. */
  binMs?: number
  /** Ignore implausibly large offsets (ms). Default 600_000 (10 min). */
  maxOffsetMs?: number
  /** Skip tokens that occur more than this many times on either side (low-information words). Default 6. */
  maxTokenFreq?: number
  /** Frontal/lateral emphasis-peak times (SECONDS) — words near a peak vote with extra weight. */
  peaksFrontalSec?: number[]
  peaksLateralSec?: number[]
  /** A word counts as "near a peak" within this window (ms). Default 250. */
  peakWindowMs?: number
}

export interface AlignResult {
  /** Lateral relative to frontal: positive ⇒ lateral started later (matches computeAudioOffset's sign). */
  offsetSeconds: number
  /** 0..1: share of frontal words whose vote landed in the modal bin (agreement). */
  confidence: number
  /** Number of frontal words that voted for the chosen offset. */
  matched: number
}

interface Tok {
  norm: string
  startMs: number
}

function tokens(words: AlignWord[]): Tok[] {
  return words
    .filter((w) => (w.type ?? 'word') === 'word')
    .map((w) => ({ norm: normalizeToken(w.text), startMs: w.startMs }))
    .filter((t) => t.norm !== '')
}

function freq(toks: Tok[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const t of toks) m.set(t.norm, (m.get(t.norm) ?? 0) + 1)
  return m
}

function nearAny(ms: number, peaksSec: number[] | undefined, windowMs: number): boolean {
  if (!peaksSec || peaksSec.length === 0) return false
  for (const p of peaksSec) if (Math.abs(p * 1000 - ms) <= windowMs) return true
  return false
}

/** Recover the offset (seconds) that shifts `lateral` onto `frontal` by matching shared words. */
export function alignByTranscript(frontal: AlignWord[], lateral: AlignWord[], opts: AlignOptions = {}): AlignResult {
  const binMs = Math.max(10, opts.binMs ?? 60)
  const maxOffsetMs = opts.maxOffsetMs ?? 600_000
  const maxFreq = Math.max(1, opts.maxTokenFreq ?? 6)
  const peakWindow = Math.max(0, opts.peakWindowMs ?? 250)

  const fTok = tokens(frontal)
  const lTok = tokens(lateral)
  if (fTok.length === 0 || lTok.length === 0) return { offsetSeconds: 0, confidence: 0, matched: 0 }

  const fFreq = freq(fTok)
  const lFreq = freq(lTok)
  // Index lateral start times by normalized token (only reasonably-unique tokens).
  const lByTok = new Map<string, number[]>()
  for (const t of lTok) {
    if ((lFreq.get(t.norm) ?? 0) > maxFreq) continue
    const arr = lByTok.get(t.norm)
    if (arr) arr.push(t.startMs)
    else lByTok.set(t.norm, [t.startMs])
  }

  // Vote: each (frontal word, matching lateral word) pair → offset = lateral - frontal. Weight loud words.
  const bins = new Map<number, number>()
  let votableFrontal = 0
  for (const f of fTok) {
    if ((fFreq.get(f.norm) ?? 0) > maxFreq) continue
    const candidates = lByTok.get(f.norm)
    if (!candidates) continue
    votableFrontal++
    const weight = 1 + (nearAny(f.startMs, opts.peaksFrontalSec, peakWindow) ? 1 : 0)
    for (const lStart of candidates) {
      const offset = lStart - f.startMs
      if (Math.abs(offset) > maxOffsetMs) continue
      const w = weight + (nearAny(lStart, opts.peaksLateralSec, peakWindow) ? 1 : 0)
      const bin = Math.round(offset / binMs)
      bins.set(bin, (bins.get(bin) ?? 0) + w)
    }
  }
  if (bins.size === 0) return { offsetSeconds: 0, confidence: 0, matched: 0 }

  // Modal bin = the global offset most word-pairs agree on.
  let bestBin = 0
  let bestVotes = -1
  for (const [bin, votes] of bins) {
    if (votes > bestVotes) {
      bestVotes = votes
      bestBin = bin
    }
  }
  const center = bestBin * binMs
  // Refine: median of the raw offsets within ±1 bin of the mode.
  const near: number[] = []
  for (const f of fTok) {
    if ((fFreq.get(f.norm) ?? 0) > maxFreq) continue
    const candidates = lByTok.get(f.norm)
    if (!candidates) continue
    for (const lStart of candidates) {
      const offset = lStart - f.startMs
      if (Math.abs(offset - center) <= binMs) near.push(offset)
    }
  }
  near.sort((a, b) => a - b)
  const medianMs = near.length ? near[Math.floor(near.length / 2)] : center
  const matched = near.length
  const confidence = votableFrontal > 0 ? Math.min(1, matched / votableFrontal) : 0
  return { offsetSeconds: medianMs / 1000, confidence, matched }
}
