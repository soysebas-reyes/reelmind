// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { parseSilenceLog } from './silence'

describe('parseSilenceLog', () => {
  it('pairs silence_start / silence_end lines', () => {
    const log = [
      'frame= 100 fps=0.0 q=-0.0 size=N/A time=00:00:04.00',
      '[silencedetect @ 0x55] silence_start: 1.5',
      '[silencedetect @ 0x55] silence_end: 3.2 | silence_duration: 1.7',
      '[silencedetect @ 0x55] silence_start: 8',
      '[silencedetect @ 0x55] silence_end: 9.25 | silence_duration: 1.25'
    ].join('\n')
    expect(parseSilenceLog(log)).toEqual([
      { start: 1.5, end: 3.2 },
      { start: 8, end: 9.25 }
    ])
  })

  it('closes a dangling start (silence to EOF) at Infinity', () => {
    expect(parseSilenceLog('[silencedetect @ 0x1] silence_start: 4.0')).toEqual([
      { start: 4, end: Number.POSITIVE_INFINITY }
    ])
  })

  it('returns empty when there are no silences', () => {
    expect(parseSilenceLog('no audio filter output here')).toEqual([])
  })
})
