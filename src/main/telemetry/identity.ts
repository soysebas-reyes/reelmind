// SPDX-License-Identifier: GPL-3.0-or-later
// Telemetry identity: a persistent anonymousId (per install; the FUTURE foreign key to a user
// account) + a per-launch sessionId. anonymousId is pseudonymous, NOT a secret, so it lives in
// plain JSON (unlike the API key in secrets.ts, which uses safeStorage).

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Identity {
  anonymousId: string
  sessionId: string
  userId?: string
}

function telemetryDir(): string {
  return join(app.getPath('userData'), 'telemetry')
}
function idPath(): string {
  return join(telemetryDir(), 'identity.json')
}

let cached: Identity | null = null

/** Load (or create) the persistent identity and mint a fresh sessionId for this launch. */
export function loadIdentity(): Identity {
  if (cached) return cached
  let anonymousId = ''
  let userId: string | undefined
  try {
    const stored = JSON.parse(readFileSync(idPath(), 'utf8')) as { anonymousId?: string; userId?: string }
    if (stored.anonymousId) anonymousId = stored.anonymousId
    userId = stored.userId
  } catch {
    // first run or unreadable → mint below
  }
  if (!anonymousId) {
    anonymousId = randomUUID()
    try {
      mkdirSync(telemetryDir(), { recursive: true })
      writeFileSync(idPath(), JSON.stringify({ anonymousId }, null, 2), 'utf8')
    } catch {
      // non-fatal: fall back to an in-memory id for this run
    }
  }
  cached = { anonymousId, sessionId: randomUUID(), userId }
  return cached
}

/** Future accounts: persist the linked userId while keeping anonymousId for pre-login linkage. */
export function setUser(userId: string | undefined): void {
  const id = loadIdentity()
  id.userId = userId
  try {
    mkdirSync(telemetryDir(), { recursive: true })
    writeFileSync(idPath(), JSON.stringify({ anonymousId: id.anonymousId, userId }, null, 2), 'utf8')
  } catch {
    // non-fatal
  }
}
