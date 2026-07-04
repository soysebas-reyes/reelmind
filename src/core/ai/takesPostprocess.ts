// SPDX-License-Identifier: GPL-3.0-or-later
// Resolve + validate an LLM take/cut plan (word indices) into absolute source-ms spans:
//  1. stitch windowed chunks into one plan (merge overlapping / open-ended takes),
//  2. resolve indices → ms, clamp, drop degenerate ranges, order + renumber takes,
//  3. union the LLM cuts with the deterministic detector's cuts (reusing mergeCleanCuts),
//  4. assign each cut to the take containing its midpoint (drop cuts outside all takes),
//  5. fill preview text from the transcript. Pure and unit-testable.

import { type CleanCut, type CleanCutKind, mergeCleanCuts } from '../edit/transcriptClean'
import type { SerialWord, WordMs } from './transcriptSerialize'
import {
  type CutKind,
  type CutSource,
  type PlannedCut,
  type PlannedTake,
  type TakeInput,
  type TakesPlanInput,
  type TakesPlanResult
} from './takesPlan'

/** Merge plan chunks from a windowed analysis into one: concat cuts, merge overlapping / continued takes
 *  (window overlap makes the boundary take pair overlap in index space; open-ended takes extend). */
export function stitchTakePlans(chunks: TakesPlanInput[]): TakesPlanInput {
  const cuts = chunks.flatMap((c) => c.cuts)
  const sorted = chunks.flatMap((c) => c.takes).sort((a, b) => a.startWordIndex - b.startWordIndex)
  const takes: TakeInput[] = []
  for (const t of sorted) {
    const last = takes[takes.length - 1]
    if (last && t.startWordIndex <= last.endWordIndex) {
      last.endWordIndex = Math.max(last.endWordIndex, t.endWordIndex)
      if (!last.summary && t.summary) last.summary = t.summary
      last.openEnded = t.openEnded
    } else {
      takes.push({ ...t })
    }
  }
  return { takes, cuts }
}

const clampIndex = (i: number, n: number): number => Math.max(0, Math.min(n - 1, Math.round(i)))

/** Resolve a (possibly inverted / out-of-range) word-index span to a source-ms span. Null if degenerate. */
function spanToMs(
  startWordIndex: number,
  endWordIndex: number,
  wordIndexToMs: WordMs[]
): { startMs: number; endMs: number } | null {
  const n = wordIndexToMs.length
  if (n === 0) return null
  const a = clampIndex(Math.min(startWordIndex, endWordIndex), n)
  const b = clampIndex(Math.max(startWordIndex, endWordIndex), n)
  const startMs = wordIndexToMs[a].startMs
  const endMs = wordIndexToMs[b].endMs
  // NaN-safe: `endMs <= startMs` is false for NaN, which would let a poisoned span through.
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null
  return { startMs, endMs }
}

/** Join the transcript words that fall inside [startMs, endMs] into a short preview string. */
function textForSpan(startMs: number, endMs: number, W: SerialWord[]): string {
  return W.filter((w) => w.startMs >= startMs && w.endMs <= endMs)
    .map((w) => w.text)
    .join(' ')
    .trim()
}

export interface ResolveOptions {
  /** Deterministic cuts (already in ms) to union with the LLM cuts. */
  deterministicCuts?: CleanCut[]
}

const overlapsMs = (a: { startMs: number; endMs: number }, list: CleanCut[]): boolean =>
  list.some((b) => a.startMs < b.endMs && b.startMs < a.endMs)

export function resolveAndValidatePlan(
  input: TakesPlanInput,
  wordIndexToMs: WordMs[],
  W: SerialWord[],
  opts: ResolveOptions = {}
): TakesPlanResult {
  const durationMs = wordIndexToMs.length ? wordIndexToMs[wordIndexToMs.length - 1].endMs : 0

  // 1. Takes → ms, drop degenerate, sort by start, renumber 1..k.
  const takes: PlannedTake[] = []
  for (const t of input.takes) {
    const span = spanToMs(t.startWordIndex, t.endWordIndex, wordIndexToMs)
    if (!span) continue
    takes.push({
      index: 0,
      startMs: span.startMs,
      endMs: span.endMs,
      title: t.title.trim() || 'Toma',
      summary: t.summary.trim(),
      // Carry the pasted-script index through the ms sort so the renderer can pair take↔guión.
      scriptIndex: t.scriptIndex
    })
  }
  takes.sort((a, b) => a.startMs - b.startMs)
  takes.forEach((t, i) => (t.index = i + 1))

  // 2. LLM cuts → CleanCut (ms), drop degenerate.
  const llmCuts: CleanCut[] = []
  for (const c of input.cuts) {
    const span = spanToMs(c.startWordIndex, c.endWordIndex, wordIndexToMs)
    if (!span) continue
    llmCuts.push({
      startMs: span.startMs,
      endMs: span.endMs,
      kind: c.kind as CleanCutKind,
      text: (c.text ?? '').trim() || textForSpan(span.startMs, span.endMs, W)
    })
  }
  const detCuts = opts.deterministicCuts ?? []

  // 3. Union + merge geometry (stronger kind wins on overlap), then tag provenance by overlap.
  const merged = mergeCleanCuts([...detCuts, ...llmCuts])

  // 4. Assign each merged cut to the take containing its midpoint; drop cuts outside all takes.
  const cuts: PlannedCut[] = []
  for (const m of merged) {
    const mid = (m.startMs + m.endMs) / 2
    const take = takes.find((t) => mid >= t.startMs && mid < t.endMs)
    if (!take) continue
    const inDet = overlapsMs(m, detCuts)
    const inLlm = overlapsMs(m, llmCuts)
    const source: CutSource = inDet && inLlm ? 'both' : inDet ? 'deterministic' : 'llm'
    cuts.push({
      startMs: m.startMs,
      endMs: m.endMs,
      kind: m.kind as CutKind,
      reason: '',
      text: m.text || textForSpan(m.startMs, m.endMs, W),
      takeIndex: take.index,
      source
    })
  }

  return { takes, cuts, durationMs }
}
