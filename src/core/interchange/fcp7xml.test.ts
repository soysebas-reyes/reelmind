// SPDX-License-Identifier: GPL-3.0-or-later
// FCP7 xmeml builder: deterministic structure + frame/timebase/path math.

import { describe, expect, it } from 'vitest'
import { type Clip, makeClip, makeTimeline, makeTrack } from '../model/timeline'
import {
  type InterchangeSource,
  buildFcp7Xml,
  fpsToTimebase,
  windowsPathToFileUrl,
  xmlEscape
} from './fcp7xml'

function src(over: Partial<InterchangeSource> = {}): InterchangeSource {
  return {
    fileId: 'file-1',
    mediaRef: 'a',
    bakeKey: 'k',
    name: 'a',
    fileUrl: 'file:///C:/media/a.mp4',
    durationFrames: 300,
    width: 1920,
    height: 1080,
    hasAudio: false,
    mediaType: 'video',
    mode: 'source',
    bakedStartFrame: 0,
    ...over
  }
}

/** clipFile that returns a per-mediaRef source, or null for a given "offline" ref. */
function byRef(map: Record<string, InterchangeSource>) {
  return (clip: Clip): InterchangeSource | null => map[clip.mediaRef] ?? null
}

describe('fpsToTimebase', () => {
  it('maps whole and fractional rates', () => {
    expect(fpsToTimebase(30)).toEqual({ timebase: 30, ntsc: false })
    expect(fpsToTimebase(25)).toEqual({ timebase: 25, ntsc: false })
    expect(fpsToTimebase(29.97)).toEqual({ timebase: 30, ntsc: true })
    expect(fpsToTimebase(23.976)).toEqual({ timebase: 24, ntsc: true })
    expect(fpsToTimebase(59.94)).toEqual({ timebase: 60, ntsc: true })
  })
})

describe('windowsPathToFileUrl', () => {
  it('encodes a drive-absolute Windows path per-segment', () => {
    expect(windowsPathToFileUrl('C:\\a b\\x.mp4')).toBe('file:///C:/a%20b/x.mp4')
  })
  it('handles UNC paths (host not encoded)', () => {
    expect(windowsPathToFileUrl('\\\\srv\\share\\clip 1.mov')).toBe('file://srv/share/clip%201.mov')
  })
  it('handles POSIX absolute paths', () => {
    expect(windowsPathToFileUrl('/Users/seb/a b.mp4')).toBe('file:///Users/seb/a%20b.mp4')
  })
})

describe('xmlEscape', () => {
  it('escapes the five XML entities', () => {
    expect(xmlEscape(`a & b < c > "d" 'e'`)).toBe('a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;')
  })
})

describe('buildFcp7Xml', () => {
  it('emits a minimal valid xmeml for an empty timeline', () => {
    const r = buildFcp7Xml({ timeline: makeTimeline(), sequenceName: 'Empty', sources: [], clipFile: () => null })
    expect(r.clipItemCount).toBe(0)
    expect(r.xml).toContain('<!DOCTYPE xmeml>')
    expect(r.xml).toContain('<xmeml version="5">')
    expect(r.xml).toContain('<name>Empty</name>')
  })

  it('places a single full-frame video clip with exact start/end/in/out + pathurl', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60 })
    const tl = makeTimeline({ fps: 30, width: 1920, height: 1080, tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })
    const r = buildFcp7Xml({ timeline: tl, sequenceName: 'Seq', sources: [src()], clipFile: byRef({ a: src() }) })
    expect(r.clipItemCount).toBe(1)
    expect(r.xml).toContain('<start>0</start>')
    expect(r.xml).toContain('<end>60</end>')
    expect(r.xml).toContain('<in>0</in>')
    expect(r.xml).toContain('<out>60</out>')
    expect(r.xml).toContain('<pathurl>file:///C:/media/a.mp4</pathurl>')
    expect(r.xml).toContain('<timebase>30</timebase>')
    expect(r.xml).toContain('<ntsc>FALSE</ntsc>')
  })

  it('computes in/out from the baked window (trimmed) vs the whole original (full)', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'a', startFrame: 0, durationFrames: 60, trimStartFrame: 30 })
    const tl = makeTimeline({ fps: 30, tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })

    const trimmed = src({ bakedStartFrame: 30 })
    const rt = buildFcp7Xml({ timeline: tl, sequenceName: 'S', sources: [trimmed], clipFile: byRef({ a: trimmed }) })
    expect(rt.xml).toContain('<in>0</in>')
    expect(rt.xml).toContain('<out>60</out>')

    const full = src({ bakedStartFrame: 0 })
    const rf = buildFcp7Xml({ timeline: tl, sequenceName: 'S', sources: [full], clipFile: byRef({ a: full }) })
    expect(rf.xml).toContain('<in>30</in>')
    expect(rf.xml).toContain('<out>90</out>')
  })

  it('stacks multicam angles and skips the hidden (opacity 0) angle, linking A/V', () => {
    const front = { ...makeClip({ id: 'F', mediaRef: 'front', startFrame: 0, durationFrames: 60 }), opacity: 1 }
    const hidden = { ...makeClip({ id: 'H', mediaRef: 'lat', startFrame: 0, durationFrames: 60 }), opacity: 0 }
    const tl = makeTimeline({
      fps: 30,
      tracks: [makeTrack({ id: 'v1', type: 'video', clips: [front] }), makeTrack({ id: 'v2', type: 'video', clips: [hidden] })]
    })
    const withAudio = src({ fileId: 'file-front', mediaRef: 'front', hasAudio: true })
    const r = buildFcp7Xml({
      timeline: tl,
      sequenceName: 'Multi',
      sources: [withAudio],
      clipFile: byRef({ front: withAudio })
    })
    // Only the visible angle survives → 1 video clipitem + 1 linked audio clipitem.
    expect(r.clipItemCount).toBe(2)
    expect(r.xml).toContain('<link>')
    expect(r.xml).toContain('<mediatype>audio</mediatype>')
    expect(r.xml).not.toContain('lat')
  })

  it('drops text clips and reports a warning', () => {
    const txt = { ...makeClip({ id: 'T', mediaRef: 't', startFrame: 0, durationFrames: 30 }), mediaType: 'text' as const, textContent: 'Hola' }
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [txt] })] })
    const r = buildFcp7Xml({ timeline: tl, sequenceName: 'S', sources: [], clipFile: () => src() })
    expect(r.clipItemCount).toBe(0)
    expect(r.warnings.some((w) => w.includes('texto'))).toBe(true)
  })

  it('skips offline clips (clipFile → null) and warns', () => {
    const clip = makeClip({ id: 'A', mediaRef: 'gone', startFrame: 0, durationFrames: 30 })
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [clip] })] })
    const r = buildFcp7Xml({ timeline: tl, sequenceName: 'S', sources: [], clipFile: () => null })
    expect(r.clipItemCount).toBe(0)
    expect(r.warnings.some((w) => w.includes('media disponible'))).toBe(true)
  })

  it('declares each <file> once, then references it by id', () => {
    const a1 = makeClip({ id: 'A1', mediaRef: 'a', startFrame: 0, durationFrames: 30 })
    const a2 = makeClip({ id: 'A2', mediaRef: 'a', startFrame: 30, durationFrames: 30 })
    const tl = makeTimeline({ tracks: [makeTrack({ id: 'v', type: 'video', clips: [a1, a2] })] })
    const s = src()
    const r = buildFcp7Xml({ timeline: tl, sequenceName: 'S', sources: [s], clipFile: byRef({ a: s }) })
    // Full <file ...> declaration appears once; the second reference is the self-closing form.
    expect((r.xml.match(/<file id="file-1">/g) ?? []).length).toBe(1)
    expect(r.xml).toContain('<file id="file-1"/>')
  })
})
