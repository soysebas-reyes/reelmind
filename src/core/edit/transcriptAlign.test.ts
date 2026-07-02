// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { type AlignWord, alignByTranscript } from './transcriptAlign'

function words(rows: [string, number][]): AlignWord[] {
  return rows.map(([text, startMs]) => ({ text, startMs, endMs: startMs + 250, type: 'word' }))
}

const SCRIPT = ['hoy', 'vamos', 'aprender', 'sobre', 'sintaxis', 'avanzada', 'porque', 'importa', 'mucho']

describe('alignByTranscript', () => {
  it('recovers a constant offset between two angles (lateral started 1.5s later)', () => {
    const frontal = words(SCRIPT.map((t, i) => [t, i * 1000] as [string, number]))
    const lateral = words(SCRIPT.map((t, i) => [t, i * 1000 + 1500] as [string, number]))
    const r = alignByTranscript(frontal, lateral)
    expect(r.offsetSeconds).toBeCloseTo(1.5, 2)
    expect(r.confidence).toBeGreaterThan(0.6)
  })

  it('is robust to a few mismatched/extra words (outliers do not move the mode)', () => {
    const frontal = words(SCRIPT.map((t, i) => [t, i * 1000] as [string, number]))
    const lateral = words([
      ['ruido', 0],
      ...SCRIPT.map((t, i) => [t, i * 1000 + 800] as [string, number]),
      ['otra', 99999]
    ])
    const r = alignByTranscript(frontal, lateral)
    expect(r.offsetSeconds).toBeCloseTo(0.8, 1)
  })

  it('reports zero confidence when there is no shared vocabulary', () => {
    const frontal = words([['alfa', 0], ['beta', 1000], ['gamma', 2000]])
    const lateral = words([['uno', 0], ['dos', 1000], ['tres', 2000]])
    const r = alignByTranscript(frontal, lateral)
    expect(r.confidence).toBe(0)
    expect(r.matched).toBe(0)
  })

  it('empty input → zero offset, zero confidence', () => {
    expect(alignByTranscript([], words([['x', 0]]))).toEqual({ offsetSeconds: 0, confidence: 0, matched: 0 })
  })
})
