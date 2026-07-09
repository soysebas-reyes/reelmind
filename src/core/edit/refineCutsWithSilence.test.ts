// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { type SilenceMs, refineCutsWithSilence } from './refineCutsWithSilence'
import type { CleanCut } from './transcriptClean'

const silenceCut = (startMs: number, endMs: number): CleanCut => ({ startMs, endMs, kind: 'silencio', text: '(silencio)' })
const fillerCut = (startMs: number, endMs: number, text = 'eh'): CleanCut => ({ startMs, endMs, kind: 'muletilla', text })

describe('refineCutsWithSilence — (a) adjust silence cuts to real silence', () => {
  it('narrows a transcript silence to the real silence inside it (excludes the breath)', () => {
    const cuts = [silenceCut(1000, 3000)]
    const sil: SilenceMs[] = [{ startMs: 1500, endMs: 2500 }] // breath in [1000,1500] and [2500,3000]
    const out = refineCutsWithSilence(cuts, sil, { microPadMs: 40 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'silencio', startMs: 1540, endMs: 2460 })
  })

  it('widens to recover padding when the real silence is wider', () => {
    const out = refineCutsWithSilence([silenceCut(1200, 2000)], [{ startMs: 1000, endMs: 2500 }], { microPadMs: 40 })
    expect(out[0]).toMatchObject({ startMs: 1040, endMs: 2460 })
  })

  it('keeps MORE air with a larger microPad (Natural aire ~250ms)', () => {
    // Same 1000..2500 real silence: microPad 125 keeps 125ms of silence on each side vs 40.
    const out = refineCutsWithSilence([silenceCut(1200, 2000)], [{ startMs: 1000, endMs: 2500 }], { microPadMs: 125 })
    expect(out[0]).toMatchObject({ startMs: 1125, endMs: 2375 })
  })

  it('keeps the transcript silence when no real silence overlaps it', () => {
    const out = refineCutsWithSilence([silenceCut(1000, 2000)], [{ startMs: 5000, endMs: 5100 }], {})
    expect(out).toEqual([{ startMs: 1000, endMs: 2000, kind: 'silencio', text: '(silencio)' }])
  })
})

describe('refineCutsWithSilence — (b) add unmarked real silences', () => {
  it('adds a long real silence the transcript never marked', () => {
    const out = refineCutsWithSilence([], [{ startMs: 1000, endMs: 1500 }], { microPadMs: 40, minRealSilenceMs: 300 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'silencio', startMs: 1040, endMs: 1460 })
  })

  it('ignores a real silence shorter than the minimum', () => {
    const out = refineCutsWithSilence([], [{ startMs: 1000, endMs: 1200 }], { microPadMs: 40, minRealSilenceMs: 300 })
    expect(out).toHaveLength(0)
  })
})

describe('refineCutsWithSilence — (c) snap filler edges into adjacent silence', () => {
  it('snaps the start edge left into a preceding silence', () => {
    const out = refineCutsWithSilence([fillerCut(1000, 1200)], [{ startMs: 850, endMs: 1010 }], { microPadMs: 40, snapWindowMs: 120 })
    expect(out[0]).toMatchObject({ kind: 'muletilla', startMs: 890, endMs: 1200 })
  })

  it('snaps the end edge right into a following silence', () => {
    const out = refineCutsWithSilence([fillerCut(1000, 1200)], [{ startMs: 1190, endMs: 1400 }], { microPadMs: 40, snapWindowMs: 120 })
    expect(out[0]).toMatchObject({ kind: 'muletilla', startMs: 1000, endMs: 1320 })
  })

  it('leaves the edge unchanged when no silence is within the snap window', () => {
    const out = refineCutsWithSilence([fillerCut(1000, 1200)], [{ startMs: 5000, endMs: 5100 }], { snapWindowMs: 120 })
    expect(out).toEqual([{ startMs: 1000, endMs: 1200, kind: 'muletilla', text: 'eh' }])
  })
})

describe('refineCutsWithSilence — robustness', () => {
  it('filters non-finite silence ranges', () => {
    const out = refineCutsWithSilence([fillerCut(1000, 1200)], [{ startMs: 1000, endMs: Infinity }], {})
    expect(out).toEqual([{ startMs: 1000, endMs: 1200, kind: 'muletilla', text: 'eh' }])
  })

  it('merges cuts that overlap after refinement', () => {
    const cuts = [silenceCut(1000, 2000), silenceCut(1900, 3000)]
    const out = refineCutsWithSilence(cuts, [{ startMs: 1500, endMs: 2800 }], { microPadMs: 40 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ startMs: 1540, endMs: 2760 })
  })
})
