// SPDX-License-Identifier: GPL-3.0-or-later
// Pure placement logic for clip copy/paste.

import { describe, expect, it } from 'vitest'
import { fxClip, fxTimeline, fxVideoTrack, fxAudioTrack } from '../testing/fixtures'
import { resolvePasteTargets, serializeSelection } from './clipboard'

describe('serializeSelection', () => {
  it('deep-copies the selected clips and records the anchor', () => {
    const a = fxClip({ id: 'A', start: 30, duration: 60 })
    const b = fxClip({ id: 'B', start: 120, duration: 30 })
    const tl = fxTimeline({ tracks: [fxVideoTrack({ id: 'V', clips: [a, b] })] })
    const payload = serializeSelection(tl, ['A', 'B'])!
    expect(payload.items).toHaveLength(2)
    expect(payload.anchorFrame).toBe(30)
    expect(payload.items[0].trackIndex).toBe(0)
    // Deep copy: mutating the payload never touches the timeline.
    payload.items[0].clip.volume = 0
    expect(a.volume).toBe(1)
  })

  it('returns null when no ids match', () => {
    const tl = fxTimeline({ tracks: [fxVideoTrack()] })
    expect(serializeSelection(tl, ['ghost'])).toBeNull()
  })
})

describe('resolvePasteTargets', () => {
  it('keeps the original track when it survives, preserving block layout from the paste frame', () => {
    const a = fxClip({ id: 'A', start: 30, duration: 60 })
    const b = fxClip({ id: 'B', start: 120, duration: 30 })
    const tl = fxTimeline({ tracks: [fxVideoTrack({ id: 'V', clips: [a, b] })] })
    const payload = serializeSelection(tl, ['A', 'B'])!
    const t = resolvePasteTargets(tl, payload, 300)
    expect(t.needTracks).toHaveLength(0)
    expect(t.existing.map((p) => p.startFrame)).toEqual([300, 390]) // 300 + (120-30)
    expect(t.existing.every((p) => p.trackId === 'V')).toBe(true)
  })

  it('falls back to the first compatible track when the original row is gone', () => {
    const src = fxTimeline({ tracks: [fxVideoTrack({ id: 'V1' }), fxVideoTrack({ id: 'V2', clips: [fxClip({ id: 'A', start: 0, duration: 30 })] })] })
    const payload = serializeSelection(src, ['A'])!
    // Paste into a project where index 1 is now an AUDIO track.
    const dst = fxTimeline({ tracks: [fxVideoTrack({ id: 'OTHER' }), fxAudioTrack({ id: 'AU' })] })
    const t = resolvePasteTargets(dst, payload, 0)
    expect(t.existing[0].trackId).toBe('OTHER')
  })

  it('requests a new track when nothing is compatible (and on an empty timeline)', () => {
    const src = fxTimeline({ tracks: [fxVideoTrack({ id: 'V', clips: [fxClip({ id: 'A', start: 10, duration: 30 })] })] })
    const payload = serializeSelection(src, ['A'])!
    const empty = fxTimeline({ tracks: [] })
    const t = resolvePasteTargets(empty, payload, 50)
    expect(t.existing).toHaveLength(0)
    expect(t.needTracks).toHaveLength(1)
    expect(t.needTracks[0].trackType).toBe('video')
    expect(t.needTracks[0].items[0].startFrame).toBe(50)
  })

  it('re-clones per call so repeated pastes never share references', () => {
    const src = fxTimeline({ tracks: [fxVideoTrack({ id: 'V', clips: [fxClip({ id: 'A', start: 0, duration: 30 })] })] })
    const payload = serializeSelection(src, ['A'])!
    const t1 = resolvePasteTargets(src, payload, 100)
    const t2 = resolvePasteTargets(src, payload, 200)
    expect(t1.existing[0].clip).not.toBe(t2.existing[0].clip)
    t1.existing[0].clip.volume = 0
    expect(t2.existing[0].clip.volume).toBe(1)
  })

  it('clamps negative landings to 0', () => {
    const src = fxTimeline({ tracks: [fxVideoTrack({ id: 'V', clips: [fxClip({ id: 'A', start: 100, duration: 30 }), fxClip({ id: 'B', start: 200, duration: 30 })] })] })
    const payload = serializeSelection(src, ['A', 'B'])!
    const t = resolvePasteTargets(src, payload, 0)
    expect(t.existing.map((p) => p.startFrame)).toEqual([0, 100])
  })
})
