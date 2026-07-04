// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import {
  extractSpokenWords,
  planWindows,
  serializeWindow,
  type SerialWord
} from './transcriptSerialize'

/** Build words from [text, startMs, endMs] tuples. */
function words(rows: [string, number, number][]): SerialWord[] {
  return rows.map(([text, startMs, endMs]) => ({ text, startMs, endMs, type: 'word' }))
}

describe('extractSpokenWords', () => {
  it('drops non-word tokens and builds a matching index→ms table', () => {
    const input: SerialWord[] = [
      { text: 'hola', startMs: 0, endMs: 300, type: 'word' },
      { text: ' ', startMs: 300, endMs: 300, type: 'spacing' },
      { text: 'mundo', startMs: 300, endMs: 700, type: 'word' }
    ]
    const { W, wordIndexToMs } = extractSpokenWords(input)
    expect(W.map((w) => w.text)).toEqual(['hola', 'mundo'])
    expect(wordIndexToMs).toEqual([
      { startMs: 0, endMs: 300 },
      { startMs: 300, endMs: 700 }
    ])
  })
})

describe('serializeWindow', () => {
  it('prints global indices, a start timestamp, and a pause marker on long gaps', () => {
    const W = words([
      ['hola', 0, 300],
      ['mundo', 400, 700],
      ['adios', 2200, 2500] // 1500ms gap before "adios"
    ])
    const text = serializeWindow(W, 0, W.length, { gapAnnotateMs: 500 })
    expect(text).toContain('#0 [t=0.00s] hola mundo')
    expect(text).toContain('[pausa 1.50s]')
    expect(text).toContain('#2 [t=2.20s] adios')
  })

  it('breaks a line at sentence-ending punctuation', () => {
    const W = words([
      ['hola', 0, 300],
      ['mundo.', 300, 700],
      ['chau', 800, 1100]
    ])
    const lines = serializeWindow(W, 0, W.length, { gapAnnotateMs: 100000 }).split('\n')
    expect(lines).toEqual(['#0 [t=0.00s] hola mundo.', '#2 [t=0.80s] chau'])
  })
})

describe('planWindows', () => {
  it('returns a single window when within budget', () => {
    const W = words([
      ['a', 0, 100],
      ['b', 100, 200],
      ['c', 200, 300]
    ])
    expect(planWindows(W, { wordBudget: 10 })).toEqual([{ startIndex: 0, endIndex: 3 }])
  })

  it('splits into overlapping windows that cover the whole transcript', () => {
    const W = words(Array.from({ length: 10 }, (_, i) => [`w${i}`, i * 100, i * 100 + 50] as [string, number, number]))
    const ranges = planWindows(W, { wordBudget: 4, overlap: 1 })
    expect(ranges[0].startIndex).toBe(0)
    expect(ranges[ranges.length - 1].endIndex).toBe(10)
    // adjacent windows overlap (a boundary take can be stitched)
    expect(ranges[1].startIndex).toBeLessThan(ranges[0].endIndex)
  })
})
