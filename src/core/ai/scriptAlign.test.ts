// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { alignScriptToTranscript, splitScriptBlocks } from './scriptAlign'
import type { SerialWord, WordMs } from './transcriptSerialize'

/** Build a spoken-only transcript (index i → [i*1000, i*1000+400]) from a word list. */
function transcript(texts: string[]): { W: SerialWord[]; wordIndexToMs: WordMs[] } {
  const W: SerialWord[] = texts.map((text, i) => ({ text, startMs: i * 1000, endMs: i * 1000 + 400, type: 'word' }))
  return { W, wordIndexToMs: W.map((w) => ({ startMs: w.startMs, endMs: w.endMs })) }
}

describe('alignScriptToTranscript', () => {
  it('perfect match → coverage 1, start at the span start', () => {
    const { W, wordIndexToMs } = transcript(['hoy', 'vamos', 'a', 'hablar', 'de', 'sintaxis'])
    const r = alignScriptToTranscript('hoy vamos a hablar de sintaxis', W, wordIndexToMs)
    expect(r.coverage).toBe(1)
    expect(r.matchedCount).toBe(6)
    expect(r.trueStartWordIndex).toBe(0)
    expect(r.endWordIndex).toBe(5)
    expect(r.confident).toBe(true)
  })

  it('partial coverage when transcript is missing some script words', () => {
    // Script has 4 tokens; transcript drops "profunda".
    const { W, wordIndexToMs } = transcript(['hola', 'gente', 'bienvenidos'])
    const r = alignScriptToTranscript('hola gente bienvenidos profunda', W, wordIndexToMs)
    expect(r.matchedCount).toBe(3)
    expect(r.totalCount).toBe(4)
    expect(r.coverage).toBeCloseTo(0.75, 5)
  })

  it('script not present → coverage 0, not confident', () => {
    const { W, wordIndexToMs } = transcript(['uno', 'dos', 'tres'])
    const r = alignScriptToTranscript('alfa beta gamma delta', W, wordIndexToMs)
    expect(r.coverage).toBe(0)
    expect(r.matchedCount).toBe(0)
    expect(r.confident).toBe(false)
    expect(r.totalCount).toBe(4)
  })

  it('corrects a late start: recovers the intro the LLM skipped', () => {
    // Full line spoken from index 0, but the LLM hinted the take started at "vamos" (index 3).
    const { W, wordIndexToMs } = transcript(['hola', 'chicos', 'hoy', 'vamos', 'a', 'grabar', 'esto'])
    const r = alignScriptToTranscript('hola chicos hoy vamos a grabar esto', W, wordIndexToMs, {
      startIndex: 3,
      endIndex: 6
    })
    expect(r.trueStartWordIndex).toBe(0)
    expect(r.startCorrected).toBe(true)
    expect(r.coverage).toBe(1)
  })

  it('does not report a correction when the LLM start was already right', () => {
    const { W, wordIndexToMs } = transcript(['hola', 'chicos', 'hoy', 'vamos'])
    const r = alignScriptToTranscript('hola chicos hoy vamos', W, wordIndexToMs, { startIndex: 0, endIndex: 3 })
    expect(r.trueStartWordIndex).toBe(0)
    expect(r.startCorrected).toBe(false)
  })

  it('anchors the instance nearest the hint when a script phrase repeats', () => {
    // Same opening appears twice; the hint points at the SECOND recital (index 10).
    const { W, wordIndexToMs } = transcript([
      'uno', 'dos', 'tres', 'cuatro', // first (discarded) attempt: 0..3
      'no', 'espera', 'me', 'trabo', 'arranco', 'otra', // chatter 4..9
      'uno', 'dos', 'tres', 'cuatro' // final good take: 10..13
    ])
    const r = alignScriptToTranscript('uno dos tres cuatro', W, wordIndexToMs, { startIndex: 10, endIndex: 13 })
    expect(r.trueStartWordIndex).toBe(10)
    expect(r.coverage).toBe(1)
  })

  it('is accent- and case-insensitive (reuses normalizeToken)', () => {
    const { W, wordIndexToMs } = transcript(['si', 'vamos', 'a', 'programar'])
    const r = alignScriptToTranscript('Sí, VAMOS a Programar', W, wordIndexToMs)
    expect(r.coverage).toBe(1)
    expect(r.matchedCount).toBe(4)
  })

  it('empty script or empty transcript → zeroed result', () => {
    const { W, wordIndexToMs } = transcript(['hola'])
    expect(alignScriptToTranscript('', W, wordIndexToMs).coverage).toBe(0)
    expect(alignScriptToTranscript('hola', [], []).coverage).toBe(0)
  })
})

describe('splitScriptBlocks', () => {
  it('splits on blank lines and trims, dropping empties', () => {
    expect(splitScriptBlocks('Guión uno\ncon dos líneas\n\n  Guión dos  \n\n\nGuión tres')).toEqual([
      'Guión uno\ncon dos líneas',
      'Guión dos',
      'Guión tres'
    ])
  })

  it('returns [] for whitespace-only input', () => {
    expect(splitScriptBlocks('   \n\n  ')).toEqual([])
  })
})
