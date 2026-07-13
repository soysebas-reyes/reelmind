// SPDX-License-Identifier: GPL-3.0-or-later
// Resolves a logical lutRef → an absolute .cube path on disk, or null if unavailable (the render then
// skips the LUT gracefully). Node-only (fs/path), no Electron, so it's unit-testable; the library dir
// (the user's side-loaded, confidential LUT folder) comes from app settings and is passed in here.

import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseLutRef } from '../../core'

export interface LutDirs {
  projectDir?: string | null
  /** User-configured "preset LUT" folder — client-confidential, side-loaded, never bundled. */
  libraryDir?: string | null
  /** userData/luts for saved profiles. */
  profileDir?: string | null
}

/** Windows drive-letter absolute (C:\… or C:/…). `path.isAbsolute` only accepts these on win32, but a
 *  .vproj saved on Windows can carry such refs into a mac session — keep them as candidates there too,
 *  so they degrade like any missing file (LUT skipped + warning) instead of being silently dropped. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/

/** Ordered absolute candidate paths for a lutRef given the available directories (pure). */
export function lutCandidatePaths(lutRef: string, dirs: LutDirs): string[] {
  const { scheme, name } = parseLutRef(lutRef)
  switch (scheme) {
    case 'absolute':
      return isAbsolute(name) || DRIVE_ABSOLUTE.test(name) ? [name] : []
    case 'preset':
      return dirs.libraryDir ? [join(dirs.libraryDir, name)] : []
    case 'profile':
      return dirs.profileDir ? [join(dirs.profileDir, name)] : []
    case 'project':
      return dirs.projectDir ? [join(dirs.projectDir, 'luts', name), join(dirs.projectDir, name)] : []
  }
}

/** First candidate path that exists on disk, or null (caller renders without the LUT + warns). */
export function resolveLut(lutRef: string, dirs: LutDirs): string | null {
  for (const candidate of lutCandidatePaths(lutRef, dirs)) {
    if (existsSync(candidate)) return candidate
  }
  return null
}
