// SPDX-License-Identifier: GPL-3.0-or-later
// Resolve + validate an LLM take/cut plan (word indices) into absolute source-ms spans:
//  1. stitch windowed chunks into one plan (merge overlapping / open-ended takes),
//  2. resolve indices → ms, clamp, drop degenerate ranges, order + renumber takes,
//  3. union the LLM cuts with the deterministic detector's cuts (reusing mergeCleanCuts),
//  4. assign each cut to the take containing its midpoint (drop cuts outside all takes),
//  5. fill preview text from the transcript. Pure and unit-testable.

import { type CleanCut, type CleanCutKind, describeCut, mergeCleanCuts } from '../edit/transcriptClean'
import { alignScriptToTranscript } from './scriptAlign'
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
  const all = chunks.flatMap((c) => c.takes)

  // Script-driven: collapse fragments of the SAME guión (scriptIndex) into ONE take even if their word-
  // index spans don't overlap — e.g. a guión split across the planWindows boundary, or the model emitting
  // two takes for one script. The overlap merge below is scriptIndex-unaware and would leave that as two
  // takes (over-segmentation → an extra low-coverage tab). Fragments WITHOUT a scriptIndex (inference
  // mode) keep the original overlap-merge, so that golden behavior is unchanged.
  const byScript = new Map<number, TakeInput>()
  const rest: TakeInput[] = []
  for (const t of all) {
    if (t.scriptIndex == null) {
      rest.push(t)
      continue
    }
    const cur = byScript.get(t.scriptIndex)
    if (!cur) {
      byScript.set(t.scriptIndex, { ...t })
      continue
    }
    cur.startWordIndex = Math.min(cur.startWordIndex, t.startWordIndex)
    if (t.endWordIndex >= cur.endWordIndex) {
      cur.endWordIndex = t.endWordIndex
      cur.openEnded = t.openEnded
    }
    if (!cur.title && t.title) cur.title = t.title
    if (!cur.summary && t.summary) cur.summary = t.summary
  }

  const sortedRest = [...rest].sort((a, b) => a.startWordIndex - b.startWordIndex)
  const mergedRest: TakeInput[] = []
  for (const t of sortedRest) {
    const last = mergedRest[mergedRest.length - 1]
    if (last && t.startWordIndex <= last.endWordIndex) {
      last.endWordIndex = Math.max(last.endWordIndex, t.endWordIndex)
      if (!last.summary && t.summary) last.summary = t.summary
      last.openEnded = t.openEnded
    } else {
      mergedRest.push({ ...t })
    }
  }

  const takes = [...byScript.values(), ...mergedRest].sort((a, b) => a.startWordIndex - b.startWordIndex)
  return { takes, cuts }
}

/** First non-empty line of a pasted guión, capped — used as a synthesized take's title. */
function scriptTitle(block: string): string {
  const line = (block.split('\n').find((l) => l.trim() !== '') ?? '').trim()
  return line.slice(0, 60) || 'Guión'
}

/** Guarantee ONE take per pasted guión (script-driven mode). For each `scriptIndex` in 0..N-1 missing
 *  from `merged.takes`, deterministically locate the guión by hintless alignment and add a take; if even
 *  that fails, add a small NON-DEGENERATE placeholder at the guión's approximate position so it survives
 *  `resolveAndValidatePlan`'s degenerate-drop and stays VISIBLE + editable (never silently omitted — the
 *  old behavior that made guiones "disappear"). Returns the augmented input and the scriptIndexes that
 *  were reconstructed (→ `reconstructed` flag / review badge). Pure; unit-testable without the LLM. */
export function fillMissingScripts(
  merged: TakesPlanInput,
  scriptBlocks: string[],
  W: SerialWord[],
  wordIndexToMs: WordMs[]
): { input: TakesPlanInput; reconstructed: number[] } {
  const N = scriptBlocks.length
  const lastIndex = wordIndexToMs.length - 1
  if (N === 0 || lastIndex < 1) return { input: merged, reconstructed: [] }
  const present = new Set<number>()
  for (const t of merged.takes) if (t.scriptIndex != null) present.add(t.scriptIndex)
  const takes = [...merged.takes]
  const reconstructed: number[] = []
  for (let si = 0; si < N; si++) {
    if (present.has(si)) continue
    const al = alignScriptToTranscript(scriptBlocks[si], W, wordIndexToMs)
    if (al.matchedCount > 0 && al.endWordIndex > al.trueStartWordIndex) {
      takes.push({ startWordIndex: al.trueStartWordIndex, endWordIndex: al.endWordIndex, title: scriptTitle(scriptBlocks[si]), summary: '', scriptIndex: si })
    } else {
      // Not locatable — small placeholder at the guión's proportional position; user drags it to place.
      const start = Math.max(0, Math.min(lastIndex - 1, Math.round(((si + 0.5) / N) * lastIndex)))
      const end = Math.min(lastIndex, start + 5)
      takes.push({ startWordIndex: start, endWordIndex: end, title: scriptTitle(scriptBlocks[si]), summary: '', scriptIndex: si })
    }
    reconstructed.push(si)
  }
  return { input: { takes, cuts: merged.cuts }, reconstructed }
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

/** The reason of the same-kind cut (in `list`) overlapping `m`, if any carries one — used to keep the
 *  human-readable explanation alive through the det∪llm merge (which doesn't track per-cut reason). */
const pickReason = (m: CleanCut, list: CleanCut[]): string | undefined =>
  list.find((c) => c.kind === m.kind && m.startMs < c.endMs && c.startMs < m.endMs && (c.reason ?? '').trim())?.reason?.trim()

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
      scriptIndex: t.scriptIndex,
      // Display number = guión the user pasted (1-based). Independent of `index` (the resolve-order join
      // key), so "Guión 4" is always the 4th pasted script regardless of where it landed in time.
      guionNumber: t.scriptIndex != null ? t.scriptIndex + 1 : undefined
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
      text: (c.text ?? '').trim() || textForSpan(span.startMs, span.endMs, W),
      reason: (c.reason ?? '').trim() || undefined
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
    // Keep the explanation alive through the merge: prefer the LLM's own reason, then the deterministic
    // detector's synthetic reason, then derive one from the merged span.
    const reason =
      pickReason(m, llmCuts) ?? pickReason(m, detCuts) ?? describeCut(m.kind as CleanCutKind, m.startMs, m.endMs, m.text)
    cuts.push({
      startMs: m.startMs,
      endMs: m.endMs,
      kind: m.kind as CutKind,
      reason,
      text: m.text || textForSpan(m.startMs, m.endMs, W),
      takeIndex: take.index,
      source
    })
  }

  return { takes, cuts, durationMs }
}
