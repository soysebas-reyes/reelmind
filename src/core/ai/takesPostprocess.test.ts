// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { fillMissingScripts, resolveAndValidatePlan, stitchTakePlans } from './takesPostprocess'
import type { SerialWord } from './transcriptSerialize'
import type { TakesPlanInput } from './takesPlan'

// 10 words, one per second, each 500ms long: index i → [i*1000, i*1000+500].
const W: SerialWord[] = Array.from({ length: 10 }, (_, i) => ({
  text: `w${i}`,
  startMs: i * 1000,
  endMs: i * 1000 + 500,
  type: 'word'
}))
const wordIndexToMs = W.map((w) => ({ startMs: w.startMs, endMs: w.endMs }))

const oneTake = (startWordIndex: number, endWordIndex: number): TakesPlanInput['takes'][number] => ({
  startWordIndex,
  endWordIndex,
  title: 'T',
  summary: 's'
})

describe('resolveAndValidatePlan', () => {
  it('resolves indices to ms and assigns each cut to its take', () => {
    const input: TakesPlanInput = {
      takes: [oneTake(0, 9)],
      cuts: [{ startWordIndex: 2, endWordIndex: 3, kind: 'muletilla', reason: 'r', text: 'x' }]
    }
    const res = resolveAndValidatePlan(input, wordIndexToMs, W)
    expect(res.takes).toHaveLength(1)
    expect(res.takes[0]).toMatchObject({ index: 1, startMs: 0, endMs: 9500 })
    expect(res.cuts).toHaveLength(1)
    expect(res.cuts[0]).toMatchObject({ startMs: 2000, endMs: 3500, takeIndex: 1, source: 'llm', reason: 'r' })
    expect(res.durationMs).toBe(9500)
  })

  it('propagates the LLM reason, and synthesizes one when the cut lacks it', () => {
    const withReason = resolveAndValidatePlan(
      { takes: [oneTake(0, 9)], cuts: [{ startWordIndex: 2, endWordIndex: 3, kind: 'muletilla', reason: 'relleno', text: 'eh' }] },
      wordIndexToMs,
      W
    )
    expect(withReason.cuts[0].reason).toBe('relleno')
    // Empty LLM reason → derived from the merged span (describeCut).
    const noReason = resolveAndValidatePlan(
      { takes: [oneTake(0, 9)], cuts: [{ startWordIndex: 5, endWordIndex: 5, kind: 'muletilla', reason: '', text: 'este' }] },
      wordIndexToMs,
      W
    )
    expect(noReason.cuts[0].reason).toBe('muletilla «este»')
  })

  it('keeps the deterministic reason when only a det cut covers the span', () => {
    const res = resolveAndValidatePlan(
      { takes: [oneTake(0, 9)], cuts: [] },
      wordIndexToMs,
      W,
      { deterministicCuts: [{ startMs: 2000, endMs: 2500, kind: 'muletilla', text: 'eh', reason: 'muletilla «eh»' }] }
    )
    expect(res.cuts).toHaveLength(1)
    expect(res.cuts[0]).toMatchObject({ source: 'deterministic', reason: 'muletilla «eh»' })
  })

  it('drops a cut that falls outside every take', () => {
    const input: TakesPlanInput = {
      takes: [oneTake(0, 4)],
      cuts: [{ startWordIndex: 7, endWordIndex: 8, kind: 'silencio', reason: '', text: '' }]
    }
    expect(resolveAndValidatePlan(input, wordIndexToMs, W).cuts).toHaveLength(0)
  })

  it('clamps out-of-range indices to the last word', () => {
    const input: TakesPlanInput = {
      takes: [oneTake(0, 9)],
      cuts: [{ startWordIndex: 50, endWordIndex: 99, kind: 'muletilla', reason: '', text: '' }]
    }
    const res = resolveAndValidatePlan(input, wordIndexToMs, W)
    expect(res.cuts[0]).toMatchObject({ startMs: 9000, endMs: 9500 })
  })

  it('carries scriptIndex through the ms sort/renumber, and sets guionNumber = scriptIndex + 1', () => {
    // Two scripts pasted in order 0,1 but recited out of order in the transcript (script 1 first).
    const input: TakesPlanInput = {
      takes: [
        { startWordIndex: 5, endWordIndex: 9, title: 'B', summary: '', scriptIndex: 1 },
        { startWordIndex: 0, endWordIndex: 4, title: 'A', summary: '', scriptIndex: 0 }
      ],
      cuts: []
    }
    const res = resolveAndValidatePlan(input, wordIndexToMs, W)
    // `index` = start-sorted join key (1,2); `guionNumber` = the pasted guión (scriptIndex+1), so the
    // out-of-order take still shows as "Guión 2" even though it resolves to join index 2.
    expect(res.takes.map((t) => [t.index, t.scriptIndex, t.guionNumber, t.startMs])).toEqual([
      [1, 0, 1, 0],
      [2, 1, 2, 5000]
    ])
  })

  it('leaves guionNumber undefined in inference mode (no scriptIndex)', () => {
    const res = resolveAndValidatePlan({ takes: [oneTake(0, 9)], cuts: [] }, wordIndexToMs, W)
    expect(res.takes[0].guionNumber).toBeUndefined()
  })

  it('drops takes and cuts whose word times are NaN (poisoned transcript)', () => {
    // The pre-fix ElevenLabs parser produced NaN for every word: `endMs <= startMs` is false for NaN,
    // so a poisoned span used to sail through and later wipe the whole timeline on apply.
    const nanIndex = W.map(() => ({ startMs: NaN, endMs: NaN }))
    const input: TakesPlanInput = {
      takes: [oneTake(0, 9)],
      cuts: [{ startWordIndex: 2, endWordIndex: 3, kind: 'muletilla', reason: '', text: '' }]
    }
    const res = resolveAndValidatePlan(input, nanIndex, W)
    expect(res.takes).toHaveLength(0)
    expect(res.cuts).toHaveLength(0)
  })

  it('unions deterministic + llm cuts and tags overlap as "both", stronger kind wins', () => {
    const input: TakesPlanInput = {
      takes: [oneTake(0, 9)],
      cuts: [{ startWordIndex: 2, endWordIndex: 2, kind: 'muletilla', reason: '', text: '' }]
    }
    const res = resolveAndValidatePlan(input, wordIndexToMs, W, {
      deterministicCuts: [{ startMs: 2000, endMs: 3000, kind: 'silencio', text: '(silencio)' }]
    })
    expect(res.cuts).toHaveLength(1)
    expect(res.cuts[0]).toMatchObject({ kind: 'silencio', source: 'both' })
  })
})

describe('stitchTakePlans', () => {
  it('merges an open-ended take with its continuation across a window overlap', () => {
    const chunkA: TakesPlanInput = {
      takes: [{ startWordIndex: 0, endWordIndex: 5, title: 'A', summary: '', openEnded: true }],
      cuts: [{ startWordIndex: 1, endWordIndex: 1, kind: 'muletilla', reason: '', text: '' }]
    }
    const chunkB: TakesPlanInput = {
      takes: [{ startWordIndex: 4, endWordIndex: 9, title: 'B', summary: 'sB' }],
      cuts: [{ startWordIndex: 7, endWordIndex: 7, kind: 'muletilla', reason: '', text: '' }]
    }
    const stitched = stitchTakePlans([chunkA, chunkB])
    expect(stitched.takes).toHaveLength(1)
    expect(stitched.takes[0]).toMatchObject({ startWordIndex: 0, endWordIndex: 9 })
    expect(stitched.cuts).toHaveLength(2)
  })

  it('collapses same-scriptIndex fragments across a window boundary even when they do NOT overlap', () => {
    // One guión (scriptIndex 0) split by the window boundary into two NON-overlapping fragments. The
    // scriptIndex-unaware overlap merge would keep these as two takes (→ over-segmentation, extra tab).
    const chunkA: TakesPlanInput = { takes: [{ startWordIndex: 0, endWordIndex: 2, title: 'A', summary: 'sa', scriptIndex: 0 }], cuts: [] }
    const chunkB: TakesPlanInput = { takes: [{ startWordIndex: 6, endWordIndex: 9, title: '', summary: '', scriptIndex: 0 }], cuts: [] }
    const stitched = stitchTakePlans([chunkA, chunkB])
    expect(stitched.takes).toHaveLength(1)
    expect(stitched.takes[0]).toMatchObject({ startWordIndex: 0, endWordIndex: 9, scriptIndex: 0, title: 'A', summary: 'sa' })
  })

  it('keeps DISTINCT scriptIndexes as separate takes', () => {
    const chunk: TakesPlanInput = {
      takes: [
        { startWordIndex: 0, endWordIndex: 3, title: 'A', summary: '', scriptIndex: 0 },
        { startWordIndex: 5, endWordIndex: 9, title: 'B', summary: '', scriptIndex: 1 }
      ],
      cuts: []
    }
    const stitched = stitchTakePlans([chunk])
    expect(stitched.takes.map((t) => t.scriptIndex)).toEqual([0, 1])
  })
})

describe('fillMissingScripts', () => {
  it('recovers a guión the model omitted by deterministic alignment (one take per guión)', () => {
    // Scripts 0 and 1; the model only returned a take for script 0. Script 1 ("w5 w6 w7") is recoverable
    // from the transcript, so it must be synthesized and flagged reconstructed.
    const merged: TakesPlanInput = { takes: [{ startWordIndex: 0, endWordIndex: 2, title: 'A', summary: '', scriptIndex: 0 }], cuts: [] }
    const { input, reconstructed } = fillMissingScripts(merged, ['w0 w1 w2', 'w5 w6 w7'], W, wordIndexToMs)
    expect(input.takes).toHaveLength(2)
    expect(reconstructed).toEqual([1])
    const recovered = input.takes.find((t) => t.scriptIndex === 1)!
    expect(recovered.startWordIndex).toBe(5)
    expect(recovered.endWordIndex).toBe(7)
  })

  it('adds a visible, non-degenerate placeholder for a guión that cannot be located (never dropped)', () => {
    const merged: TakesPlanInput = { takes: [], cuts: [] }
    const { input, reconstructed } = fillMissingScripts(merged, ['zzz qqq no aparece'], W, wordIndexToMs)
    expect(reconstructed).toEqual([0])
    expect(input.takes).toHaveLength(1)
    const ph = input.takes[0]
    expect(ph.scriptIndex).toBe(0)
    // Non-degenerate span → survives resolveAndValidatePlan's degenerate-drop (stays visible/editable).
    expect(ph.endWordIndex).toBeGreaterThan(ph.startWordIndex)
    expect(resolveAndValidatePlan(input, wordIndexToMs, W).takes).toHaveLength(1)
  })

  it('is a no-op when every guión is already present', () => {
    const merged: TakesPlanInput = {
      takes: [
        { startWordIndex: 0, endWordIndex: 2, title: 'A', summary: '', scriptIndex: 0 },
        { startWordIndex: 5, endWordIndex: 7, title: 'B', summary: '', scriptIndex: 1 }
      ],
      cuts: []
    }
    const { input, reconstructed } = fillMissingScripts(merged, ['w0 w1 w2', 'w5 w6 w7'], W, wordIndexToMs)
    expect(reconstructed).toEqual([])
    expect(input.takes).toHaveLength(2)
  })
})
