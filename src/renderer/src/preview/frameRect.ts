// SPDX-License-Identifier: GPL-3.0-or-later
// Letterbox math shared by the Preview draw() and the get_frame_preview capturer: where the
// project frame sits inside the panel. Pure and unit-testable.

export interface FrameRect {
  fx: number
  fy: number
  fw: number
  fh: number
}

/** Fit a projectW×projectH frame into a width×height panel with `pad` margin, centered. */
export function frameRect(width: number, height: number, projectW: number, projectH: number, pad = 14): FrameRect {
  const availW = Math.max(0, width - pad * 2)
  const availH = Math.max(0, height - pad * 2)
  const aspect = projectW / projectH
  let fw = availW
  let fh = availW / aspect
  if (fh > availH) {
    fh = availH
    fw = availH * aspect
  }
  return { fx: (width - fw) / 2, fy: (height - fh) / 2, fw, fh }
}
