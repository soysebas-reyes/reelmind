// SPDX-License-Identifier: GPL-3.0-or-later
// Turn a word-level transcript into an EXPLICIT text the LLM can segment precisely. Every spoken word
// gets a stable GLOBAL index; sentences print as `#<startIndex> [t=SS.ss s] words…`, with `[pausa X.Ys]`
// markers wherever a silent gap opens (so the model can treat pauses as candidate take boundaries).
// The model answers in word INDICES; `extractSpokenWords` also returns the index→ms table used to
// resolve those indices back to exact source ms. No IO, no framework — pure and unit-testable.

/** Minimal transcript word (subset of the app's TranscriptWord). */
export interface SerialWord {
  text: string
  startMs: number
  endMs: number
  type?: 'word' | 'spacing' | 'audio_event'
}

export interface WordMs {
  startMs: number
  endMs: number
}

export interface SerializeOptions {
  /** Emit a `[pausa]` marker when the gap before a word exceeds this (ms). Default 500 — kept BELOW the
   *  deterministic silence-cut threshold so the model SEES pauses it may use as take boundaries. */
  gapAnnotateMs?: number
  /** Force a line break after this many words even without sentence punctuation. Default 20. */
  maxWordsPerLine?: number
}

export interface WindowOptions {
  /** Max spoken words per window. Default 1200 (~8–10 min of speech). */
  wordBudget?: number
  /** Overlap (words) carried between adjacent windows so a boundary take can be stitched. Default 150. */
  overlap?: number
}

/** A word ending a sentence: trailing . ? ! … (optionally followed by a closing quote/paren). */
const SENTENCE_END = /[.?!…]+["'”’)\]]*$/

/** Build the spoken-word index space (drops spacing/audio_event tokens) + the index→ms table. The
 *  index of a word here is exactly what the model returns in `startWordIndex`/`endWordIndex`. */
export function extractSpokenWords(words: SerialWord[]): { W: SerialWord[]; wordIndexToMs: WordMs[] } {
  const W = words.filter((w) => (w.type ?? 'word') === 'word')
  const wordIndexToMs = W.map((w) => ({ startMs: w.startMs, endMs: w.endMs }))
  return { W, wordIndexToMs }
}

function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(2)
}

/** Serialize the half-open range [startIndex, endIndex) of `W` into the explicit prompt text. Prints
 *  GLOBAL indices, so a windowed chunk's answers map straight back to the full transcript. */
export function serializeWindow(
  W: SerialWord[],
  startIndex: number,
  endIndex: number,
  opts: SerializeOptions = {}
): string {
  const gapMs = Math.max(0, opts.gapAnnotateMs ?? 500)
  const maxWords = Math.max(4, opts.maxWordsPerLine ?? 20)
  const s = Math.max(0, startIndex)
  const e = Math.min(W.length, endIndex)
  const lines: string[] = []
  let lineStart = -1
  let buf: string[] = []
  const flush = (): void => {
    if (lineStart < 0 || buf.length === 0) return
    lines.push(`#${lineStart} [t=${fmtSec(W[lineStart].startMs)}s] ${buf.join(' ')}`)
    lineStart = -1
    buf = []
  }
  for (let i = s; i < e; i++) {
    if (i > s) {
      const gap = W[i].startMs - W[i - 1].endMs
      if (gap > gapMs) {
        flush()
        lines.push(`#${i} [pausa ${fmtSec(gap)}s]`)
      }
    }
    if (lineStart < 0) lineStart = i
    buf.push(W[i].text)
    if (SENTENCE_END.test(W[i].text.trim()) || buf.length >= maxWords) flush()
  }
  flush()
  return lines.join('\n')
}

/** Convenience: serialize the whole transcript in one window. */
export function serializeTranscriptForLLM(
  words: SerialWord[],
  opts: SerializeOptions = {}
): { text: string; wordIndexToMs: WordMs[] } {
  const { W, wordIndexToMs } = extractSpokenWords(words)
  return { text: serializeWindow(W, 0, W.length, opts), wordIndexToMs }
}

/** Plan windows over `W`: fixed word budget with an overlap tail, snapping each window's end back to the
 *  nearest sentence end inside its last ~15% when possible. Returns half-open [startIndex, endIndex). */
export function planWindows(W: SerialWord[], opts: WindowOptions = {}): { startIndex: number; endIndex: number }[] {
  const budget = Math.max(1, opts.wordBudget ?? 1200)
  const overlap = Math.max(0, Math.min(opts.overlap ?? 150, budget - 1))
  if (W.length <= budget) return [{ startIndex: 0, endIndex: W.length }]
  const ranges: { startIndex: number; endIndex: number }[] = []
  let start = 0
  while (start < W.length) {
    let end = Math.min(W.length, start + budget)
    if (end < W.length) {
      const floor = start + Math.floor(budget * 0.85)
      for (let i = end - 1; i >= floor; i--) {
        if (SENTENCE_END.test(W[i].text.trim())) {
          end = i + 1
          break
        }
      }
    }
    ranges.push({ startIndex: start, endIndex: end })
    if (end >= W.length) break
    start = Math.max(0, end - overlap)
  }
  return ranges
}
