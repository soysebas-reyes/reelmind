// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { parseScribeWords } from './transcript'

describe('parseScribeWords', () => {
  it('maps the real Scribe v1 shape (start/end in seconds) to ms', () => {
    const words = parseScribeWords([
      { text: 'hola', start: 0.12, end: 0.58, type: 'word', speaker_id: 'speaker_0' },
      { text: ' ', start: 0.58, end: 0.71, type: 'spacing' },
      { text: 'mundo', start: 0.71, end: 1.2, type: 'word' }
    ])
    expect(words).toEqual([
      { text: 'hola', startMs: 120, endMs: 580, type: 'word', speakerId: 'speaker_0' },
      { text: ' ', startMs: 580, endMs: 710, type: 'spacing', speakerId: null },
      { text: 'mundo', startMs: 710, endMs: 1200, type: 'word', speakerId: null }
    ])
  })

  it('accepts the legacy start_time/end_time fields as fallback', () => {
    const words = parseScribeWords([{ text: 'hola', start_time: 1.5, end_time: 2, type: 'word' }])
    expect(words).toEqual([{ text: 'hola', startMs: 1500, endMs: 2000, type: 'word', speakerId: null }])
  })

  it('throws when spoken words carry no timestamps (instead of emitting NaN)', () => {
    expect(() => parseScribeWords([{ text: 'hola', type: 'word' }])).toThrow(/timestamps/)
  })

  it('drops non-word tokens without usable times instead of poisoning the list', () => {
    const words = parseScribeWords([
      { text: 'hola', start: 0, end: 0.4, type: 'word' },
      { text: '(risas)', type: 'audio_event' }
    ])
    expect(words).toHaveLength(1)
    expect(words[0].text).toBe('hola')
  })

  it('returns [] for an empty/missing words array', () => {
    expect(parseScribeWords(undefined)).toEqual([])
    expect(parseScribeWords([])).toEqual([])
  })
})
