// SPDX-License-Identifier: GPL-3.0-or-later
// Deterministic alignment of a pasted SCRIPT (guión) against the spoken transcript. The LLM already
// picks the rough span a script was recited in, but (a) it can start the take AFTER the script's first
// line (skipping intro hesitations) and (b) it never proves the whole script was actually found. This
// pure pass fixes both without touching the model: tokenize the script + transcript identically
// (normalizeToken), find where the script's opening words land, then measure how much of the script's
// words appear IN ORDER from there. It returns a corrected start word index + a coverage score so the
// UI can snap the take start to the real beginning and flag scripts that weren't fully found. No IO.

import { normalizeToken } from '../edit/transcriptClean'
import type { SerialWord, WordMs } from './transcriptSerialize'

/** How many leading script tokens must land as a tight cluster to trust the start anchor. */
const ANCHOR_TOKENS = 4
/** The anchor cluster must span no more than this many transcript words (rejects scattered matches). */
const ANCHOR_MAX_SPREAD = 12
/** When an LLM hint is given, look back this many words before it to catch a skipped intro. */
const HINT_LOOKBACK = 60

export interface ScriptAlignHint {
  /** The LLM's take span in spoken-word indices — search is scoped around it. */
  startIndex: number
  endIndex: number
}

export interface ScriptAlignResult {
  /** Spoken-word index where the script actually starts (its first matched token). */
  trueStartWordIndex: number
  /** Spoken-word index of the script's last matched token (inclusive). */
  endWordIndex: number
  /** Script tokens found, in order, within the matched region. */
  matchedCount: number
  /** Total content tokens in the script. */
  totalCount: number
  /** matchedCount / totalCount, 0..1. */
  coverage: number
  /** True when the anchored start sits earlier than the LLM hint's start (an intro was recovered). */
  startCorrected: boolean
  /** True when the opening tokens anchored tightly enough to trust `trueStartWordIndex`. */
  confident: boolean
}

const EMPTY: ScriptAlignResult = {
  trueStartWordIndex: 0,
  endWordIndex: 0,
  matchedCount: 0,
  totalCount: 0,
  coverage: 0,
  startCorrected: false,
  confident: false
}

function normTokens(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t !== '')
}

/** Spoken words → normalized tokens keeping the original spoken-word index for each. */
function transcriptTokens(W: SerialWord[]): { norm: string; index: number }[] {
  const out: { norm: string; index: number }[] = []
  for (let i = 0; i < W.length; i++) {
    if ((W[i].type ?? 'word') !== 'word') continue
    const norm = normalizeToken(W[i].text)
    if (norm !== '') out.push({ norm, index: i })
  }
  return out
}

/** Every transcript position (offset into `toks`, within [fromOffset, toOffset)) where the script's
 *  first ANCHOR_TOKENS content tokens appear in order within a tight window. */
function findAnchors(
  scriptToks: string[],
  toks: { norm: string; index: number }[],
  fromOffset: number,
  toOffset: number
): number[] {
  const anchor = scriptToks.slice(0, Math.min(ANCHOR_TOKENS, scriptToks.length))
  const need = anchor.length <= 1 ? 1 : Math.ceil(anchor.length * 0.75)
  const hits: number[] = []
  for (let start = fromOffset; start < toOffset; start++) {
    if (toks[start].norm !== anchor[0]) continue
    // Greedily match the rest of the anchor in order, bounded by ANCHOR_MAX_SPREAD.
    let ai = 1
    let ti = start + 1
    const limit = start + ANCHOR_MAX_SPREAD
    while (ai < anchor.length && ti < toks.length && ti <= limit) {
      if (toks[ti].norm === anchor[ai]) ai++
      ti++
    }
    if (ai >= need) hits.push(start)
  }
  return hits
}

/** Align one pasted script block to the transcript, returning a corrected start + coverage.
 *  `hint` scopes the search around the LLM's span (with look-back for a skipped intro); omit it to
 *  search the whole transcript. Pure — safe to unit test. */
export function alignScriptToTranscript(
  scriptText: string,
  W: SerialWord[],
  wordIndexToMs: WordMs[],
  hint?: ScriptAlignHint
): ScriptAlignResult {
  const scriptToks = normTokens(scriptText)
  const toks = transcriptTokens(W)
  if (scriptToks.length === 0 || toks.length === 0) return { ...EMPTY, totalCount: scriptToks.length }

  // Scope the search to an offset window in `toks` around the hint (look back to catch a skipped intro).
  let fromOffset = 0
  let toOffset = toks.length
  let hintOffset = 0
  if (hint) {
    const lo = Math.max(0, hint.startIndex - HINT_LOOKBACK)
    // toks is index-sorted; binary-ish scan is overkill for these sizes — linear map is fine.
    fromOffset = toks.findIndex((t) => t.index >= lo)
    if (fromOffset < 0) fromOffset = 0
    let hiOff = toks.findIndex((t) => t.index > hint.endIndex)
    if (hiOff < 0) hiOff = toks.length
    toOffset = hiOff
    const hs = toks.findIndex((t) => t.index >= hint.startIndex)
    hintOffset = hs < 0 ? fromOffset : hs
  }

  // Pick the anchor occurrence nearest the hint start (scripts are recorded sequentially; the true
  // start sits just before the LLM's start). Without a hint, take the earliest occurrence.
  const anchors = findAnchors(scriptToks, toks, fromOffset, toOffset)
  let anchorOffset = -1
  if (anchors.length > 0) {
    anchorOffset = hint
      ? anchors.reduce((best, a) => (Math.abs(a - hintOffset) < Math.abs(best - hintOffset) ? a : best), anchors[0])
      : anchors[0]
  }
  const confident = anchorOffset >= 0
  // Start matching from the anchor when trusted, else from the hint's start (LLM's choice).
  const startOffset = confident ? anchorOffset : hint ? hintOffset : 0

  // Monotonic greedy coverage: walk script tokens, advancing through the transcript in order. Extra
  // transcript words (fillers/repeats) are skipped; missing script words simply lower coverage.
  let matched = 0
  let ti = startOffset
  let firstMatchOffset = -1
  let lastMatchOffset = startOffset
  for (const st of scriptToks) {
    let found = -1
    for (let k = ti; k < toks.length; k++) {
      if (toks[k].norm === st) {
        found = k
        break
      }
    }
    if (found >= 0) {
      matched++
      if (firstMatchOffset < 0) firstMatchOffset = found
      lastMatchOffset = found
      ti = found + 1
    }
  }
  if (firstMatchOffset < 0) return { ...EMPTY, totalCount: scriptToks.length }

  const trueStartWordIndex = toks[firstMatchOffset].index
  const endWordIndex = toks[lastMatchOffset].index
  const coverage = matched / scriptToks.length
  const startCorrected = confident && hint ? trueStartWordIndex < hint.startIndex : false

  // Guard: keep indices inside the resolvable table.
  const clampedStart = Math.min(trueStartWordIndex, wordIndexToMs.length - 1)
  const clampedEnd = Math.min(Math.max(endWordIndex, clampedStart), wordIndexToMs.length - 1)

  return {
    trueStartWordIndex: clampedStart,
    endWordIndex: clampedEnd,
    matchedCount: matched,
    totalCount: scriptToks.length,
    coverage,
    startCorrected,
    confident
  }
}

/** Split the user's pasted scripts textarea into blocks (one guión per blank-line-separated block). */
export function splitScriptBlocks(scripts: string): string[] {
  return scripts
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b !== '')
}
