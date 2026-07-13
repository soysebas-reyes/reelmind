// SPDX-License-Identifier: GPL-3.0-or-later
// Locates the CapCut / CapCut-desktop draft ROOT — the folder whose immediate subfolders each appear
// as a draft in CapCut's "Drafts" grid. When found, the CapCut handoff writes its draft folder in
// here so it shows up in CapCut with no manual move. Detection is best-effort: users can relocate the
// draft folder inside CapCut, so we also honor an explicit override and fall back to a user-picked folder.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Candidate draft roots, most-specific first. Covers CapCut Global + the 剪映/JianYing CN builds. */
function candidates(): string[] {
  const out: string[] = []
  const override = process.env.REELO_CAPCUT_DRAFT_DIR
  if (override) out.push(override)
  const draftLeaf = join('User Data', 'Projects', 'com.lveditor.draft')
  if (process.platform === 'darwin') {
    // CapCut mac keeps drafts under ~/Movies/<brand>/…. If the Mac App Store build turns out to
    // sandbox them under ~/Library/Containers, add that candidate after verifying on a real install;
    // the env override above covers the gap meanwhile.
    for (const brand of ['CapCut', 'JianyingPro']) out.push(join(homedir(), 'Movies', brand, draftLeaf))
  } else {
    for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
      if (!base) continue
      out.push(join(base, 'CapCut', draftLeaf))
      out.push(join(base, 'JianyingPro', draftLeaf))
    }
  }
  return out
}

/** Absolute path to CapCut's draft root, or null if CapCut doesn't appear to be installed here. */
export function capcutDraftRoot(): string | null {
  for (const c of candidates()) {
    try {
      if (existsSync(c)) return c
    } catch {
      // ignore unreadable candidates
    }
  }
  return null
}
