// SPDX-License-Identifier: GPL-3.0-or-later
// BYOK key storage. The Anthropic API key is encrypted at rest with Electron safeStorage
// (Windows DPAPI) and kept in userData. It never leaves the main process — the renderer only
// ever asks "is a key set?" and "run this completion", never reads the key back.

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

function keyFilePath(): string {
  return join(app.getPath('userData'), 'anthropic.key')
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    await clearApiKey()
    return
  }
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  await fs.writeFile(keyFilePath(), bytes)
}

export async function getApiKey(): Promise<string | null> {
  try {
    const bytes = await fs.readFile(keyFilePath())
    if (safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(bytes)
      } catch {
        // File predates encryption availability — fall back to raw bytes.
        return bytes.toString('utf8')
      }
    }
    return bytes.toString('utf8')
  } catch {
    return null
  }
}

export async function hasApiKey(): Promise<boolean> {
  return (await getApiKey()) !== null
}

export async function clearApiKey(): Promise<void> {
  try {
    await fs.unlink(keyFilePath())
  } catch {
    // already absent
  }
}
