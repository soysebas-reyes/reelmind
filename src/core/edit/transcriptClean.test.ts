// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILLERS,
  type CleanWord,
  describeCut,
  detectTranscriptCleanCuts,
  mergeCleanCuts,
  normalizePhrase,
  normalizeToken
} from './transcriptClean'

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
    expect(sil).toEqual({ startMs: 400, endMs: 2200, kind: 'silencio', text: '(silencio)', reason: 'silencio 1.8 s' })
  })

  it('does not cut short gaps', () => {
    const w = words([
      ['uno', 0, 300],
      ['dos', 500, 800]
    ])
    expect(detectTranscriptCleanCuts(w, { maxGapMs: 700 })).toHaveLength(0)
  })

  it('keeps MORE air between phrases with a larger gapPadding (the "aire" control)', () => {
    // 2000ms gap. Tight air (60/side) removes almost all of it; relaxed air (250/side) leaves a beat.
    const w = words([
      ['uno', 0, 300],
      ['dos', 2300, 2600]
    ])
    const tight = detectTranscriptCleanCuts(w, { maxGapMs: 350, gapPaddingMs: 60 }).find((c) => c.kind === 'silencio')!
    const relaxed = detectTranscriptCleanCuts(w, { maxGapMs: 350, gapPaddingMs: 250 }).find((c) => c.kind === 'silencio')!
    const removedTight = tight.endMs - tight.startMs
    const removedRelaxed = relaxed.endMs - relaxed.startMs
    expect(removedRelaxed).toBeLessThan(removedTight) // relaxed cuts less → keeps more air
    expect(removedTight - removedRelaxed).toBe(380) // (250-60)*2 more silence kept
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

describe('detectTranscriptCleanCuts — filler words & phrases', () => {
  it('cuts a hard isolated filler ("eh")', () => {
    const w = words([
      ['bien', 0, 300],
      ['eh', 300, 500],
      ['listo', 500, 900]
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 100000 })
    const f = cuts.find((c) => c.kind === 'muletilla' && c.text === 'eh')
    expect(f).toBeTruthy()
    expect(f!.reason).toBe('muletilla «eh»')
  })

  it('cuts a multi-word filler phrase ("o sea") when flanked by a pause', () => {
    const w = words([
      ['listo', 0, 400],
      ['o', 900, 1100], // 500ms pause before → clause boundary
      ['sea', 1100, 1400],
      ['seguimos', 1900, 2400] // 500ms pause after
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 100000, boundaryGapMs: 200 })
    const p = cuts.find((c) => c.kind === 'muletilla' && normalizeToken(c.text.replace(/\s/g, '')) === 'osea')
    expect(p).toBeTruthy()
    expect(p!.startMs).toBe(900)
    expect(p!.endMs).toBe(1400)
  })

  it('does NOT cut an ambiguous phrase used literally with no surrounding pause', () => {
    // "yo no sé nada" spoken tight (no boundary pauses) → left for the LLM, not cut mechanically.
    const w = words([
      ['yo', 0, 200],
      ['no', 200, 400],
      ['sé', 400, 600],
      ['nada', 600, 900],
      ['de', 900, 1100],
      ['eso', 1100, 1400]
    ])
    const cuts = detectTranscriptCleanCuts(w, { maxGapMs: 100000, boundaryGapMs: 200 })
    expect(cuts).toHaveLength(0)
  })
})

describe('DEFAULT_FILLERS', () => {
  it('has no duplicates and does not contain the bigram token "osea"', () => {
    expect(new Set(DEFAULT_FILLERS).size).toBe(DEFAULT_FILLERS.length)
    expect(DEFAULT_FILLERS).not.toContain('osea')
  })
})

describe('describeCut / normalizePhrase', () => {
  it('builds Spanish reasons per kind', () => {
    expect(describeCut('muletilla', 0, 200, 'eh')).toBe('muletilla «eh»')
    expect(describeCut('silencio', 400, 2200)).toBe('silencio 1.8 s')
    expect(describeCut('repeticion', 0, 500)).toBe('repetición (se conserva la última)')
    expect(describeCut('falso-inicio', 0, 300, 'te voy a')).toBe('falso inicio «te voy a»')
  })
  it('tokenizes a phrase, normalizing accents', () => {
    expect(normalizePhrase('o sea')).toEqual(['o', 'sea'])
    expect(normalizePhrase('  Es  Decir ')).toEqual(['es', 'decir'])
  })
})

describe('mergeCleanCuts', () => {
  it('merges overlaps and keeps the stronger kind + its reason', () => {
    const merged = mergeCleanCuts([
      { startMs: 0, endMs: 1000, kind: 'silencio', text: 'a', reason: 'silencio 1.0 s' },
      { startMs: 500, endMs: 1500, kind: 'falso-inicio', text: 'b', reason: 'falso inicio' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 1500, kind: 'falso-inicio', reason: 'falso inicio' })
  })
})
