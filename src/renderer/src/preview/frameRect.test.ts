// SPDX-License-Identifier: GPL-3.0-or-later
// Letterbox math shared by Preview.draw() and the get_frame_preview capturer.

import { describe, expect, it } from 'vitest'
import { frameRect } from './frameRect'

describe('frameRect', () => {
  it('fits a 16:9 project into a wide panel height-bound', () => {
    const r = frameRect(1000, 400, 1920, 1080)
    // availH = 372 binds: fh=372, fw=372*16/9
    expect(r.fh).toBeCloseTo(372, 5)
    expect(r.fw).toBeCloseTo((372 * 16) / 9, 5)
    expect(r.fx).toBeCloseTo((1000 - r.fw) / 2, 5)
    expect(r.fy).toBeCloseTo(14, 5)
  })

  it('fits a vertical 9:16 project width-free, centered', () => {
    const r = frameRect(800, 600, 1080, 1920)
    expect(r.fh).toBeCloseTo(572, 5) // height-bound
    expect(r.fw).toBeCloseTo(572 * (1080 / 1920), 5)
    expect(r.fx + r.fw / 2).toBeCloseTo(400, 5) // centered
  })

  it('is width-bound when the panel is tall', () => {
    const r = frameRect(400, 2000, 1920, 1080)
    expect(r.fw).toBeCloseTo(372, 5)
    expect(r.fh).toBeCloseTo(372 / (1920 / 1080), 5)
  })

  it('never returns negative sizes for tiny panels', () => {
    const r = frameRect(10, 10, 1920, 1080)
    expect(r.fw).toBeGreaterThanOrEqual(0)
    expect(r.fh).toBeGreaterThanOrEqual(0)
  })
})
