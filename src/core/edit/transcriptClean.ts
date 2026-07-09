// SPDX-License-Identifier: GPL-3.0-or-later
// Pure, heuristic "clean takes" detection over a word-level transcript: find the spans to REMOVE so only
// the final, complete take of each idea survives. Targets mechanical signals (no LLM): false starts /
// repeated phrases, stutters + filler words (single AND multi-word), and long silences (from word gaps).
// No IO, no framework — the renderer feeds it transcript words and maps the returned ms ranges to timeline
// frames + cuts. Aggressive on the unambiguous stuff; ambiguous filler phrases are only cut when they sit
// at a clause boundary (flanked by a pause), leaving contextual judgment to the LLM + human review.

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
  /** Human-readable Spanish explanation shown in the review UI. */
  reason?: string
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
  /** Isolated filler words to drop ALWAYS (hard hesitations). Normalized internally. */
  fillers?: string[]
  /** Ambiguous filler phrases (single or multi-word), cut only when flanked by a clause boundary.
   *  Each entry is a normalized token sequence (see `normalizePhrase`). */
  fillerPhrases?: string[][]
  /** A pause this long (ms) around a word counts as a clause boundary (guards ambiguous phrases). Default 200. */
  boundaryGapMs?: number
}

/** Hard hesitations: always cut when they appear isolated (never carry meaning). */
export const DEFAULT_FILLERS: string[] = ['eh', 'ehh', 'ehm', 'em', 'mmm', 'mm', 'este', 'pues', 'aja']

/** Ambiguous fillers (single AND multi-word): only cut when flanked by a clause boundary, because they
 *  can be meaningful ("no SÉ nada de eso", "está BUENO"). The LLM handles the contextual cases. */
export const FILLER_PHRASES: string[] = [
  'o sea',
  'osea',
  'es decir',
  'por así decirlo',
  'digamos que',
  'digamos',
  'me explico',
  'no sé',
  'qué sé yo',
  'viste que',
  'viste',
  'nada que ver',
  'la verdad',
  'en plan',
  'bueno',
  'nada',
  'tipo',
  'claro',
  'igual',
  'entonces',
  'obviamente',
  'básicamente',
  'onda',
  'literal'
]

/** Lowercase, strip accents/diacritics and any non-alphanumeric so "Sí," ≈ "si". */
export function normalizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics (á→a, ñ→n)
    .replace(/[^a-z0-9]/g, '')
}

/** Split a raw phrase ("o sea") into its normalized tokens (["o","sea"]), dropping empties. */
export function normalizePhrase(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t !== '')
}

/** Human-readable Spanish reason for a cut, shown in the review UI. */
export function describeCut(kind: CleanCutKind, startMs: number, endMs: number, text?: string): string {
  const t = (text ?? '').trim()
  switch (kind) {
    case 'muletilla':
      return t ? `muletilla «${t}»` : 'muletilla'
    case 'silencio':
      return `silencio ${((Math.max(0, endMs - startMs)) / 1000).toFixed(1)} s`
    case 'repeticion':
      return 'repetición (se conserva la última)'
    case 'falso-inicio':
      return t ? `falso inicio «${t}»` : 'falso inicio'
  }
}

/** Merge overlapping/adjacent cuts (sorted ascending). When two overlap, the stronger kind wins,
 *  and its reason is kept (so the dominant kind's explanation survives the merge). */
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
      if (priority[cur.kind] > priority[last.kind]) {
        last.kind = cur.kind
        last.reason = cur.reason
      }
      last.text = `${last.text} ${cur.text}`.trim()
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

/** Detect the spans to remove. Returns cuts sorted ASCENDING by startMs (display order); the caller
 *  maps them to timeline frames and applies right-to-left. Aggressive on the unambiguous stuff; the
 *  preview lets the user disable any cut. */
export function detectTranscriptCleanCuts(words: CleanWord[], opts: CleanOptions = {}): CleanCut[] {
  const minRun = Math.max(2, opts.minRepeatRun ?? 3)
  const lookahead = Math.max(minRun, opts.repeatLookaheadWords ?? 14)
  const maxGapMs = Math.max(0, opts.maxGapMs ?? 700)
  const pad = Math.max(0, opts.gapPaddingMs ?? 120)
  const boundaryGapMs = Math.max(0, opts.boundaryGapMs ?? 200)
  const fillers = new Set((opts.fillers ?? DEFAULT_FILLERS).map(normalizeToken))
  const phrases = (opts.fillerPhrases ?? FILLER_PHRASES.map(normalizePhrase)).filter((p) => p.length > 0)

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
      const text = textOf(i, hit.j)
      cuts.push({
        startMs: w[i].startMs,
        endMs: w[hit.j].startMs,
        kind: 'falso-inicio',
        text,
        reason: describeCut('falso-inicio', w[i].startMs, w[hit.j].startMs, text)
      })
      for (let k = i; k < hit.j; k++) removedUntil[k] = true
      i = hit.j
    } else {
      i++
    }
  }

  // Whether index k sits at a clause boundary (start/end of speech, or flanked by a pause / a removed span).
  const gapBefore = (k: number): number => (k > 0 ? w[k].startMs - w[k - 1].endMs : Infinity)
  const gapAfter = (k: number): number => (k < w.length - 1 ? w[k + 1].startMs - w[k].endMs : Infinity)
  const boundaryBefore = (k: number): boolean => k === 0 || removedUntil[k - 1] || gapBefore(k) >= boundaryGapMs
  const boundaryAfter = (k: number): boolean => k === w.length - 1 || removedUntil[k + 1] || gapAfter(k) >= boundaryGapMs

  // 2) Multi-word / ambiguous filler PHRASES — only when flanked by a clause boundary (guards meaningful use).
  const consumed = new Array(w.length).fill(false)
  for (let k = 0; k < w.length; k++) {
    if (removedUntil[k] || consumed[k]) continue
    for (const phrase of phrases) {
      const len = phrase.length
      if (k + len > w.length) continue
      let match = true
      for (let d = 0; d < len; d++) {
        if (removedUntil[k + d] || consumed[k + d] || w[k + d].norm !== phrase[d]) {
          match = false
          break
        }
      }
      if (!match) continue
      const end = k + len - 1
      // Flanked = boundary on at least one side, or an adjacent filler/removed neighbor.
      const flanked = boundaryBefore(k) || boundaryAfter(end)
      if (!flanked) continue
      const text = textOf(k, end + 1)
      cuts.push({
        startMs: w[k].startMs,
        endMs: w[end].endMs,
        kind: 'muletilla',
        text,
        reason: describeCut('muletilla', w[k].startMs, w[end].endMs, text)
      })
      for (let d = 0; d < len; d++) consumed[k + d] = true
      break
    }
  }

  // 3) Stutters (immediate identical word) + isolated hard fillers — skip words already removed/consumed.
  for (let k = 0; k < w.length; k++) {
    if (removedUntil[k] || consumed[k]) continue
    if (k > 0 && !removedUntil[k - 1] && !consumed[k - 1] && w[k].norm === w[k - 1].norm) {
      cuts.push({
        startMs: w[k - 1].startMs,
        endMs: w[k].startMs,
        kind: 'muletilla',
        text: w[k - 1].text,
        reason: describeCut('muletilla', w[k - 1].startMs, w[k].startMs, w[k - 1].text)
      })
    } else if (fillers.has(w[k].norm)) {
      cuts.push({
        startMs: w[k].startMs,
        endMs: w[k].endMs,
        kind: 'muletilla',
        text: w[k].text,
        reason: describeCut('muletilla', w[k].startMs, w[k].endMs, w[k].text)
      })
    }
  }

  // 4) Long silences from word gaps (leading silence + between-word gaps), shrunk by padding.
  if (w[0].startMs > maxGapMs) {
    const e = Math.max(0, w[0].startMs - pad)
    cuts.push({ startMs: 0, endMs: e, kind: 'silencio', text: '(silencio inicial)', reason: describeCut('silencio', 0, e) })
  }
  for (let k = 0; k < w.length - 1; k++) {
    const gap = w[k + 1].startMs - w[k].endMs
    if (gap > maxGapMs) {
      const s = w[k].endMs + pad
      const e = w[k + 1].startMs - pad
      if (e > s) cuts.push({ startMs: s, endMs: e, kind: 'silencio', text: '(silencio)', reason: describeCut('silencio', s, e) })
    }
  }

  return mergeCleanCuts(cuts)
}
