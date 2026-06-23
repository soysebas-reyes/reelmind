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

/** A parsed 3D `.cube` LUT, ready to upload as a WebGL 3D texture. `data` is `size³` RGB triplets
 *  (length `size³·3`) with the RED component varying fastest — exactly the layout `texImage3D`
 *  expects when sampled as `texture(lut, vec3(r,g,b))`. FFmpeg's `lut3d` reads the same files, so the
 *  in-shader live preview and the FFmpeg still/export share one source of truth. */
export interface CubeLut {
  size: number
  data: Float32Array
}

/** Parse an IRIDAS/Adobe `.cube` 3D LUT. Honors `DOMAIN_MIN`/`DOMAIN_MAX` (and `LUT_3D_INPUT_RANGE`)
 *  by normalizing entries back to 0..1; ignores comments, blank lines, and `TITLE`. Throws on a 1D LUT
 *  or malformed/short data so the caller (the IPC host) can skip the LUT and warn rather than upload
 *  garbage. Entry order (red fastest) is preserved. */
export function parseCubeLut(text: string): CubeLut {
  let size = 0
  const domainMin: [number, number, number] = [0, 0, 0]
  const domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const tok = line.split(/\s+/)
    const key = tok[0].toUpperCase()
    if (key === 'TITLE') continue
    if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported — provide a 3D .cube')
    if (key === 'LUT_3D_SIZE') {
      size = Number.parseInt(tok[1], 10)
      continue
    }
    if (key === 'DOMAIN_MIN') {
      domainMin[0] = Number(tok[1])
      domainMin[1] = Number(tok[2])
      domainMin[2] = Number(tok[3])
      continue
    }
    if (key === 'DOMAIN_MAX') {
      domainMax[0] = Number(tok[1])
      domainMax[1] = Number(tok[2])
      domainMax[2] = Number(tok[3])
      continue
    }
    if (key === 'LUT_3D_INPUT_RANGE') {
      domainMin[0] = domainMin[1] = domainMin[2] = Number(tok[1])
      domainMax[0] = domainMax[1] = domainMax[2] = Number(tok[2])
      continue
    }
    if (tok.length < 3) continue
    const r = Number.parseFloat(tok[0])
    const g = Number.parseFloat(tok[1])
    const b = Number.parseFloat(tok[2])
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) continue
    values.push(r, g, b)
  }

  if (size <= 0) throw new Error('No LUT_3D_SIZE found — not a 3D .cube')
  const expected = size * size * size * 3
  if (values.length !== expected) {
    throw new Error(`LUT data size mismatch: expected ${expected} values for a ${size}³ LUT, got ${values.length}`)
  }

  const dr = domainMax[0] - domainMin[0] || 1
  const dg = domainMax[1] - domainMin[1] || 1
  const db = domainMax[2] - domainMin[2] || 1
  const data = new Float32Array(expected)
  for (let i = 0; i < expected; i += 3) {
    data[i] = (values[i] - domainMin[0]) / dr
    data[i + 1] = (values[i + 1] - domainMin[1]) / dg
    data[i + 2] = (values[i + 2] - domainMin[2]) / db
  }
  return { size, data }
}
