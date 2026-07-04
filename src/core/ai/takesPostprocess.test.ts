// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { resolveAndValidatePlan, stitchTakePlans } from './takesPostprocess'
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
    expect(res.cuts[0]).toMatchObject({ startMs: 2000, endMs: 3500, takeIndex: 1, source: 'llm' })
    expect(res.durationMs).toBe(9500)
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

  it('carries scriptIndex through the ms sort/renumber', () => {
    // Two scripts pasted in order 0,1 but recited out of order in the transcript (script 1 first).
    const input: TakesPlanInput = {
      takes: [
        { startWordIndex: 5, endWordIndex: 9, title: 'B', summary: '', scriptIndex: 1 },
        { startWordIndex: 0, endWordIndex: 4, title: 'A', summary: '', scriptIndex: 0 }
      ],
      cuts: []
    }
    const res = resolveAndValidatePlan(input, wordIndexToMs, W)
    // Sorted by startMs → take at index 0 comes first, but each keeps its own scriptIndex.
    expect(res.takes.map((t) => [t.index, t.scriptIndex, t.startMs])).toEqual([
      [1, 0, 0],
      [2, 1, 5000]
    ])
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
})
