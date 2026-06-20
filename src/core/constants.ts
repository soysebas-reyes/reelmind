// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Utilities/Constants.swift (GPL-3.0, © Palmier, Inc.)

/** Swift's `Double.rounded()` rounds half away from zero; JS `Math.round` rounds half up.
 *  This matches Swift so frame math is identical for negative/fractional values. */
export function sround(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x))
}

export const Defaults = {
  pixelsPerFrame: 4.0,
  imageDurationSeconds: 5.0,
  audioTTSDurationSeconds: 10.0,
  audioMusicDurationSeconds: 60.0,
  textDurationSeconds: 3.0,
  aspectTolerance: 0.02
} as const

export const Snap = {
  thresholdPixels: 8.0,
  stickyMultiplier: 1.5,
  playheadMultiplier: 1.5
} as const

/** Maps a linear amplitude multiplier to dB and back for the volume model.
 *  Below the floor we snap to true 0 (hard mute). */
export const VolumeScale = {
  floorDb: -60,
  ceilingDb: 15,
  dbFromLinear(linear: number): number {
    if (linear <= 0) return VolumeScale.floorDb
    return Math.min(VolumeScale.ceilingDb, Math.max(VolumeScale.floorDb, 20 * Math.log10(linear)))
  },
  linearFromDb(db: number): number {
    if (db <= VolumeScale.floorDb) return 0
    return Math.pow(10, Math.min(db, VolumeScale.ceilingDb) / 20)
  }
} as const

/** Project package layout (the Windows `.vproj` equivalent of upstream's `.palmier`). */
export const ProjectFiles = {
  extension: 'vproj',
  projectFilename: 'project.json',
  timelineFilename: 'timeline.json',
  manifestFilename: 'manifest.json',
  thumbnailFilename: 'thumbnail.jpg',
  mediaDirectoryName: 'media',
  cacheDirectoryName: 'cache',
  defaultProjectName: 'Untitled Project'
} as const

export function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/** Stable unique id. Uses Web Crypto, available in Node 19+ and the Chromium renderer. */
export function newId(): string {
  return globalThis.crypto.randomUUID()
}
