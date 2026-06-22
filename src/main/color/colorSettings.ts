// SPDX-License-Identifier: GPL-3.0-or-later
// App-level color settings in userData (Phase 9.5): the side-loaded "preset LUT library" folder.
// For dev convenience it defaults to <app>/Guia_Colorizacion (or <cwd>/…) when present, so the
// document presets resolve out of the box; in production the user points it at their own
// (client-confidential) LUT folder via the inspector.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ColorSettings {
  lutLibraryDir?: string
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'colorSettings.json')
}

function read(): ColorSettings {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8')) as ColorSettings
  } catch {
    return {}
  }
}

/** The user's configured LUT library, or a dev default if one exists, or null. */
export function getLutLibraryDir(): string | null {
  const saved = read().lutLibraryDir
  if (saved && existsSync(saved)) return saved
  for (const base of [app.getAppPath(), process.cwd()]) {
    const candidate = join(base, 'Guia_Colorizacion')
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function setLutLibraryDir(dir: string | null): void {
  writeFileSync(settingsPath(), JSON.stringify({ lutLibraryDir: dir ?? undefined }, null, 2), 'utf8')
}

/** Where saved-profile LUTs live (self-contained, cross-project). */
export function profileLutDir(): string {
  return join(app.getPath('userData'), 'luts')
}
