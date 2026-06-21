// SPDX-License-Identifier: GPL-3.0-or-later
// LUT reference parsing (Phase 9.5). A clip/preset stores a logical `lutRef`; the host resolves it to
// an absolute .cube path at render time. Pure string parsing only (no fs/path) so it stays in @core
// and is usable from the renderer — the actual path resolution (which touches disk) lives in main.

export type LutScheme = 'preset' | 'profile' | 'project' | 'absolute'

export interface ParsedLutRef {
  scheme: LutScheme
  /** Filename (preset/profile) or path (project/absolute). */
  name: string
}

/** `preset:<file>` (side-loaded library), `profile:<file>` (userData), an absolute path, or a
 *  project-relative path. The LUT binary is never bundled — see main/color/lutResolver. */
export function parseLutRef(ref: string): ParsedLutRef {
  if (ref.startsWith('preset:')) return { scheme: 'preset', name: ref.slice('preset:'.length) }
  if (ref.startsWith('profile:')) return { scheme: 'profile', name: ref.slice('profile:'.length) }
  if (/^([a-zA-Z]:[\\/]|\/)/.test(ref)) return { scheme: 'absolute', name: ref }
  return { scheme: 'project', name: ref }
}
