// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { type CleanWord, detectTranscriptCleanCuts, mergeCleanCuts, normalizeToken } from './transcriptClean'

/** Build words from [text, startMs, endMs] tuples (gap = silence between them). */
function words(rows: [string, number, number][]): CleanWord[] {
  return rows.map(([text, startMs, endMs]) => ({ text, startMs, endMs, type: 'word' }))
}

describe('normalizeToken', () => {
  it('lowercases and strips accents + punctuation', () => {
    expect(normalizeToken('Sí,')).toBe('si')
    expect(normalizeToken('AÑO.')).toBe('ano')
    expect(normalizeToken('  ¡Hola!  ')).toBe('hola')
  })
})

describe('detectTranscriptCleanCuts — false starts / repeats', () => {
  it('removes the first occurrence of a restarted phrase, keeping the later take', () => {
    // "hoy les voy" (false start) ... restart "hoy les voy a contar algo"
    const w = words([
      ['hoy', 0, 300],
      ['les', 300, 600],
      ['voy', 600, 900],
      ['hoy', 1200, 1500],
      ['les', 1500, 1800],
      ['voy', 1800, 2100],
      ['a', 2100, 2300],
      ['contar', 2300, 2800]
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 100000 }) // disable silence detection
    const fs = cuts.find((c) => c.kind === 'falso-inicio')
    expect(fs).toBeTruthy()
    expect(fs!.startMs).toBe(0)
    expect(fs!.endMs).toBe(1200) // up to the restart word's start
  })

  it('keeps clean speech with no repeats untouched', () => {
    const w = words([
      ['uno', 0, 300],
      ['dos', 300, 600],
      ['tres', 600, 900],
      ['cuatro', 900, 1200]
    ])
    expect(detectTranscriptCleanCuts(w, { maxGapMs: 100000 })).toHaveLength(0)
  })
})

describe('detectTranscriptCleanCuts — silences', () => {
  it('cuts a long gap between words (minus padding)', () => {
    const w = words([
      ['uno', 0, 300],
      ['dos', 2300, 2600] // 2000ms gap
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 700, gapPaddingMs: 100 })
    const sil = cuts.find((c) => c.kind === 'silencio')
    expect(sil).toEqual({ startMs: 400, endMs: 2200, kind: 'silencio', text: '(silencio)' })
  })

  it('does not cut short gaps', () => {
    const w = words([
      ['uno', 0, 300],
      ['dos', 500, 800]
    ])
    expect(detectTranscriptCleanCuts(w, { maxGapMs: 700 })).toHaveLength(0)
  })
})

describe('detectTranscriptCleanCuts — stutters', () => {
  it('removes an immediate duplicate word', () => {
    const w = words([
      ['yo', 0, 200],
      ['yo', 200, 400],
      ['creo', 400, 800]
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 100000 })
    expect(cuts.some((c) => c.kind === 'muletilla' && c.startMs === 0 && c.endMs === 200)).toBe(true)
  })
})

describe('mergeCleanCuts', () => {
  it('merges overlaps and keeps the stronger kind', () => {
    const merged = mergeCleanCuts([
      { startMs: 0, endMs: 1000, kind: 'silencio', text: 'a' },
      { startMs: 500, endMs: 1500, kind: 'falso-inicio', text: 'b' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 1500, kind: 'falso-inicio' })
  })
})
