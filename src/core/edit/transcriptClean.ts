// SPDX-License-Identifier: GPL-3.0-or-later
// Pure, heuristic "clean takes" detection over a word-level transcript: find the spans to REMOVE so only
// the final, complete take of each idea survives. Targets mechanical signals (no LLM): false starts /
// repeated phrases, stutters + filler words, and long silences (from word gaps). No IO, no framework —
// the renderer feeds it transcript words and maps the returned ms ranges to timeline frames + cuts.

/** Minimal transcript word (subset of the app's TranscriptWord). */
export interface CleanWord {
  text: string
  startMs: number
  endMs: number
  type?: 'word' | 'spacing' | 'audio_event'
}

export type CleanCutKind = 'falso-inicio' | 'repeticion' | 'silencio' | 'muletilla'

/** A source-time span (ms) proposed for removal, with why + the words it covers (for the preview). */
export interface CleanCut {
  startMs: number
  endMs: number
  kind: CleanCutKind
  text: string
}

export interface CleanOptions {
  /** Minimum matching run length (words) to call something a repeated take. Default 3. */
  minRepeatRun?: number
  /** How far ahead (in words) a restart may begin to still count as a false start. Default 14. */
  repeatLookaheadWords?: number
  /** Gaps between consecutive words longer than this (ms) are cut as silence. Default 700. */
  maxGapMs?: number
  /** Keep this much audio (ms) on each side of speech when cutting a silence. Default 120. */
  gapPaddingMs?: number
  /** Isolated filler words to drop (already normalized). */
  fillers?: string[]
}

const DEFAULT_FILLERS = ['este', 'eh', 'em', 'mmm', 'ehh', 'este', 'pues', 'osea']

/** Lowercase, strip accents/diacritics and any non-alphanumeric so "Sí," ≈ "si". */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (á→a, ñ→n)
    .replace(/[^a-z0-9]/g, '')
}

/** Merge overlapping/adjacent cuts (sorted ascending). When two overlap, the stronger kind wins. */
export function mergeCleanCuts(cuts: CleanCut[]): CleanCut[] {
  if (cuts.length === 0) return []
  const priority: Record<CleanCutKind, number> = { 'falso-inicio': 3, repeticion: 2, silencio: 1, muletilla: 0 }
  const sorted = [...cuts].sort((a, b) => a.startMs - b.startMs)
  const out: CleanCut[] = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]
    const last = out[out.length - 1]
    if (cur.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, cur.endMs)
      if (priority[cur.kind] > priority[last.kind]) last.kind = cur.kind
      last.text = `${last.text} ${cur.text}`.trim()
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/** Detect the spans to remove. Returns cuts sorted ASCENDING by startMs (display order); the caller
 *  maps them to timeline frames and applies right-to-left. Conservative by design — the preview lets
 *  the user disable any cut. */
export function detectTranscriptCleanCuts(words: CleanWord[], opts: CleanOptions = {}): CleanCut[] {
  const minRun = Math.max(2, opts.minRepeatRun ?? 3)
  const lookahead = Math.max(minRun, opts.repeatLookaheadWords ?? 14)
  const maxGapMs = Math.max(0, opts.maxGapMs ?? 700)
  const pad = Math.max(0, opts.gapPaddingMs ?? 120)
  const fillers = new Set((opts.fillers ?? DEFAULT_FILLERS).map(normalizeToken))

  // Only real spoken words, normalized, dropping tokens that normalize to nothing (punctuation/spacing).
  const w = words
    .filter((x) => (x.type ?? 'word') === 'word')
    .map((x) => ({ ...x, norm: normalizeToken(x.text) }))
    .filter((x) => x.norm !== '')
  const cuts: CleanCut[] = []
  if (w.length === 0) return cuts

  const textOf = (a: number, b: number): string =>
    w
      .slice(a, b)
      .map((x) => x.text)
      .join(' ')

  // 1) False starts / repeated phrases: a run of ≥minRun words that reappears soon after → remove the
  //    FIRST occurrence (plus dead air up to the restart), keeping the later (final) take.
  const removedUntil = new Array(w.length).fill(false)
  let i = 0
  while (i < w.length) {
    let hit: { j: number } | null = null
    for (let j = i + 1; j <= Math.min(i + lookahead, w.length - 1); j++) {
      let L = 0
      while (i + L < j && j + L < w.length && w[i + L].norm === w[j + L].norm) L++
      if (L >= minRun) {
        hit = { j }
        break
      }
    }
    if (hit) {
      cuts.push({ startMs: w[i].startMs, endMs: w[hit.j].startMs, kind: 'falso-inicio', text: textOf(i, hit.j) })
      for (let k = i; k < hit.j; k++) removedUntil[k] = true
      i = hit.j
    } else {
      i++
    }
  }

  // 2) Stutters (immediate identical word) + isolated fillers — skip words already inside a false start.
  for (let k = 0; k < w.length; k++) {
    if (removedUntil[k]) continue
    if (k > 0 && !removedUntil[k - 1] && w[k].norm === w[k - 1].norm) {
      cuts.push({ startMs: w[k - 1].startMs, endMs: w[k].startMs, kind: 'muletilla', text: w[k - 1].text })
    } else if (fillers.has(w[k].norm)) {
      cuts.push({ startMs: w[k].startMs, endMs: w[k].endMs, kind: 'muletilla', text: w[k].text })
    }
  }

  // 3) Long silences from word gaps (leading silence + between-word gaps), shrunk by padding.
  if (w[0].startMs > maxGapMs) {
    cuts.push({ startMs: 0, endMs: Math.max(0, w[0].startMs - pad), kind: 'silencio', text: '(silencio inicial)' })
  }
  for (let k = 0; k < w.length - 1; k++) {
    const gap = w[k + 1].startMs - w[k].endMs
    if (gap > maxGapMs) {
      const s = w[k].endMs + pad
      const e = w[k + 1].startMs - pad
      if (e > s) cuts.push({ startMs: s, endMs: e, kind: 'silencio', text: '(silencio)' })
    }
  }

  return mergeCleanCuts(cuts)
}
