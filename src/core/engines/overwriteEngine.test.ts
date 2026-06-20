// SPDX-License-Identifier: GPL-3.0-or-later
// Golden tests ported from palmier-pro Tests/.../Timeline/OverwriteEngineTests.swift

import { describe, expect, it } from 'vitest'
import { fxClip } from '../testing/fixtures'
import { type Clip, clipEndFrame } from '../model/timeline'
import { type OverwriteAction, computeOverwrite } from './overwriteEngine'

describe('OverwriteEngine.computeOverwrite', () => {
  it('empty region produces no actions', () => {
    const clip = fxClip({ start: 0, duration: 100 })
    expect(computeOverwrite([clip], 50, 50)).toEqual([])
    expect(computeOverwrite([clip], 60, 50)).toEqual([])
  })

  it('no clips produces no actions', () => {
    expect(computeOverwrite([], 0, 100)).toEqual([])
  })

  it('clip fully outside region is ignored', () => {
    const before = fxClip({ id: 'before', start: 0, duration: 40 })
    const after = fxClip({ id: 'after', start: 200, duration: 50 })
    expect(computeOverwrite([before, after], 50, 150)).toEqual([])
  })

  it('clip fully inside region is removed', () => {
    const clip = fxClip({ id: 'c1', start: 60, duration: 40 })
    const actions = computeOverwrite([clip], 50, 150)
    expect(actions).toEqual([{ kind: 'remove', clipId: 'c1' }])
  })

  it('clip exactly matching region is removed', () => {
    const clip = fxClip({ id: 'c1', start: 50, duration: 100 })
    const actions = computeOverwrite([clip], 50, 150)
    expect(actions[0].kind).toBe('remove')
  })

  it('clip enveloping region is split', () => {
    const clip = fxClip({ id: 'c1', start: 0, duration: 200 })
    const actions = computeOverwrite([clip], 50, 150)
    expect(actions).toHaveLength(1)
    const a = actions[0]
    expect(a.kind).toBe('split')
    if (a.kind === 'split') {
      expect(a.clipId).toBe('c1')
      expect(a.leftDuration).toBe(50)
      expect(a.rightStartFrame).toBe(150)
      expect(a.rightTrimStart).toBe(150) // trimStart 0 + (150-0)*1.0
      expect(a.rightDuration).toBe(50)
    }
  })

  it('split respects speed and trimStart', () => {
    const clip = fxClip({ id: 'c1', start: 0, duration: 200, trimStart: 10, speed: 2.0 })
    const actions = computeOverwrite([clip], 50, 150)
    const a = actions[0]
    expect(a.kind).toBe('split')
    if (a.kind === 'split') {
      expect(a.leftDuration).toBe(50)
      expect(a.rightStartFrame).toBe(150)
      expect(a.rightTrimStart).toBe(310) // 10 + (150-0)*2.0
      expect(a.rightDuration).toBe(50)
    }
  })

  it('clip overlapping left edge is trimEnd', () => {
    const clip = fxClip({ id: 'c1', start: 0, duration: 100 })
    const actions = computeOverwrite([clip], 50, 200)
    expect(actions).toEqual([{ kind: 'trimEnd', clipId: 'c1', newDuration: 50 }])
  })

  it('clip overlapping right edge is trimStart', () => {
    const clip = fxClip({ id: 'c1', start: 50, duration: 100 })
    const actions = computeOverwrite([clip], 0, 100)
    expect(actions).toEqual([
      { kind: 'trimStart', clipId: 'c1', newStartFrame: 100, newTrimStart: 50, newDuration: 50 }
    ])
  })

  it('trimStart respects speed and trimStart', () => {
    const clip = fxClip({ id: 'c1', start: 50, duration: 100, trimStart: 10, speed: 2.0 })
    const actions = computeOverwrite([clip], 0, 100)
    const a = actions[0]
    expect(a.kind).toBe('trimStart')
    if (a.kind === 'trimStart') {
      expect(a.newStartFrame).toBe(100)
      expect(a.newTrimStart).toBe(110) // 10 + (100-50)*2.0
      expect(a.newDuration).toBe(50)
    }
  })

  it('adjacent edges do not trigger', () => {
    const left = fxClip({ id: 'left', start: 0, duration: 50 })
    const right = fxClip({ id: 'right', start: 150, duration: 50 })
    expect(computeOverwrite([left, right], 50, 150)).toEqual([])
  })

  it('multiple clips produce one action each', () => {
    const inside = fxClip({ id: 'inside', start: 60, duration: 30 })
    const leftOverlap = fxClip({ id: 'left', start: 0, duration: 60 })
    const rightOverlap = fxClip({ id: 'right', start: 100, duration: 200 })
    const actions = computeOverwrite([inside, leftOverlap, rightOverlap], 50, 150)
    expect(actions).toHaveLength(3)
  })
})

// Apply an action sequence to a clip array (mimics what the editor does).
function apply(actions: OverwriteAction[], clips: Clip[]): Clip[] {
  let result = [...clips]
  for (const action of actions) {
    switch (action.kind) {
      case 'remove':
        result = result.filter((c) => c.id !== action.clipId)
        break
      case 'trimEnd': {
        const c = result.find((x) => x.id === action.clipId)
        if (c) c.durationFrames = action.newDuration
        break
      }
      case 'trimStart': {
        const c = result.find((x) => x.id === action.clipId)
        if (c) {
          c.startFrame = action.newStartFrame
          c.trimStartFrame = action.newTrimStart
          c.durationFrames = action.newDuration
        }
        break
      }
      case 'split': {
        const c = result.find((x) => x.id === action.clipId)
        if (c) {
          const right = { ...c, id: action.rightId, startFrame: action.rightStartFrame, trimStartFrame: action.rightTrimStart, durationFrames: action.rightDuration }
          c.durationFrames = action.leftDuration
          result.push(right)
        }
        break
      }
    }
  }
  return result.sort((a, b) => a.startFrame - b.startFrame)
}

const overlaps = (a: Clip, b: Clip): boolean => a.startFrame < clipEndFrame(b) && b.startFrame < clipEndFrame(a)

describe('OverwriteEngine — adversarial', () => {
  it('actions clear the region across all branches', () => {
    const region = { start: 50, end: 150 }
    const scenarios: [string, Clip[]][] = [
      ['inside', [fxClip({ id: 'x', start: 60, duration: 40 })]],
      ['exactly matching', [fxClip({ id: 'x', start: 50, duration: 100 })]],
      ['overlaps left', [fxClip({ id: 'x', start: 0, duration: 100 })]],
      ['overlaps right', [fxClip({ id: 'x', start: 100, duration: 100 })]],
      ['envelops', [fxClip({ id: 'x', start: 0, duration: 200 })]],
      ['envelop + speed', [fxClip({ id: 'x', start: 0, duration: 200, speed: 2.0 })]],
      ['trimStart non-zero', [fxClip({ id: 'x', start: 0, duration: 200, trimStart: 10 })]]
    ]
    for (const [name, clips] of scenarios) {
      const actions = computeOverwrite(clips, region.start, region.end)
      const after = apply(actions, clips)
      const occupant = after.find((c) => c.startFrame < region.end && clipEndFrame(c) > region.start)
      expect(occupant, `${name}: clip still occupies region`).toBeUndefined()
    }
  })

  it('actions do not produce overlapping survivors', () => {
    const scenarios: Clip[][] = [
      [fxClip({ id: 'x', start: 0, duration: 200 })],
      [fxClip({ id: 'a', start: 0, duration: 60 }), fxClip({ id: 'b', start: 100, duration: 200 })]
    ]
    for (const clips of scenarios) {
      const actions = computeOverwrite(clips, 50, 150)
      const after = apply(actions, clips)
      for (let i = 0; i < after.length; i++) {
        for (let j = i + 1; j < after.length; j++) {
          expect(overlaps(after[i], after[j])).toBe(false)
        }
      }
    }
  })

  it('adjacent clip at regionEnd is not touched', () => {
    const after = fxClip({ id: 'b', start: 100, duration: 50 })
    expect(computeOverwrite([after], 50, 100)).toEqual([])
  })

  it('zero-duration clip does not crash', () => {
    const zeroClip = fxClip({ id: 'z', start: 100, duration: 0 })
    expect(() => computeOverwrite([zeroClip], 50, 150)).not.toThrow()
  })
})
