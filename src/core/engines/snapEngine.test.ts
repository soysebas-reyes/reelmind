// SPDX-License-Identifier: GPL-3.0-or-later
// Golden tests ported from palmier-pro Tests/.../Timeline/SnapEngineTests.swift

import { describe, expect, it } from 'vitest'
import { fxClip, fxVideoTrack } from '../testing/fixtures'
import { type SnapTarget, collectTargets, findSnap, makeSnapState } from './snapEngine'

const basePx = 8
const pxPerFrame = 4
const edge = (frame: number): SnapTarget => ({ frame, kind: 'clipEdge' })

describe('SnapEngine.collectTargets', () => {
  it('empty tracks produces no targets', () => {
    expect(collectTargets({ tracks: [], includePlayhead: false })).toEqual([])
  })

  it('includes playhead only when requested', () => {
    const withPlayhead = collectTargets({ tracks: [], playheadFrame: 75, includePlayhead: true })
    expect(withPlayhead).toHaveLength(1)
    expect(withPlayhead[0]).toEqual({ frame: 75, kind: 'playhead' })

    const without = collectTargets({ tracks: [], playheadFrame: 75, includePlayhead: false })
    expect(without).toEqual([])
  })

  it('produces start and end for each clip', () => {
    const track = fxVideoTrack({ clips: [fxClip({ id: 'a', start: 0, duration: 50 }), fxClip({ id: 'b', start: 100, duration: 80 })] })
    const targets = collectTargets({ tracks: [track] })
    expect(targets.map((t) => t.frame).sort((x, y) => x - y)).toEqual([0, 50, 100, 180])
    expect(targets.every((t) => t.kind === 'clipEdge')).toBe(true)
  })

  it('skips excluded clip ids', () => {
    const track = fxVideoTrack({ clips: [fxClip({ id: 'drag', start: 0, duration: 50 }), fxClip({ id: 'static', start: 100, duration: 80 })] })
    const targets = collectTargets({ tracks: [track], excludeClipIds: new Set(['drag']) })
    expect(targets.map((t) => t.frame).sort((x, y) => x - y)).toEqual([100, 180])
  })
})

describe('SnapEngine.findSnap — threshold', () => {
  it('returns null when no targets', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 100, targets: [], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result).toBeNull()
    expect(state.currentlySnappedTo).toBeNull()
  })

  it('returns null when beyond threshold', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 55, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result).toBeNull()
    expect(state.currentlySnappedTo).toBeNull()
  })

  it('snaps within threshold', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result?.frame).toBe(50)
    expect(result?.probeOffset).toBe(0)
    expect(result?.x).toBe(200) // 50 * 4
    expect(state.currentlySnappedTo).toBe(50)
  })

  it('picks closest of multiple targets; first wins on tie', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 50, targets: [edge(49), edge(51)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result?.frame).toBe(49)
  })
})

describe('SnapEngine.findSnap — sticky', () => {
  it('stays sticky within hold threshold', () => {
    const state = makeSnapState()
    findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(state.currentlySnappedTo).toBe(50)
    // Hold threshold = 2 * 1.5 = 3 frames; pos=53 is exactly at the boundary, still stuck.
    const stuck = findSnap({ position: 53, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(stuck?.frame).toBe(50)
    expect(state.currentlySnappedTo).toBe(50)
  })

  it('releases sticky beyond hold threshold', () => {
    const state = makeSnapState()
    findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    const result = findSnap({ position: 54, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result).toBeNull()
    expect(state.currentlySnappedTo).toBeNull()
  })

  it('releases when sticky target disappears', () => {
    const state = makeSnapState()
    findSnap({ position: 49, targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(state.currentlySnappedTo).toBe(50)
    const result = findSnap({ position: 50, targets: [edge(200)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result).toBeNull()
    expect(state.currentlySnappedTo).toBeNull()
  })
})

describe('SnapEngine.findSnap — playhead + probes', () => {
  it('playhead has wider threshold', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 103, targets: [{ frame: 100, kind: 'playhead' }], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result?.frame).toBe(100)
  })

  it('playhead still fails outside its wider threshold', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 104, targets: [{ frame: 100, kind: 'playhead' }], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result).toBeNull()
  })

  it('multiple probes picks closest probe/target pair', () => {
    const state = makeSnapState()
    const result = findSnap({ position: 70, probeOffsets: [0, 30], targets: [edge(50), edge(100)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(result?.frame).toBe(100)
    expect(result?.probeOffset).toBe(30)
    expect(state.currentProbeOffset).toBe(30)
  })
})

describe('SnapEngine — adversarial', () => {
  it('does not leave state behind when no target matches', () => {
    const state = makeSnapState()
    const r = findSnap({ position: 50, targets: [edge(1000)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(r).toBeNull()
    expect(state.currentlySnappedTo).toBeNull()
    expect(state.currentProbeOffset).toBe(0)
  })

  it('zero pixelsPerFrame does not crash', () => {
    const state = makeSnapState()
    expect(() => findSnap({ position: 1_000_000, targets: [edge(50)], state, baseThreshold: 8, pixelsPerFrame: 0 })).not.toThrow()
  })

  it('empty probeOffsets produces no snap', () => {
    const state = makeSnapState()
    const r = findSnap({ position: 50, probeOffsets: [], targets: [edge(50)], state, baseThreshold: basePx, pixelsPerFrame: pxPerFrame })
    expect(r).toBeNull()
  })
})
