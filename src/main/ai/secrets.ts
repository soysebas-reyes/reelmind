// SPDX-License-Identifier: GPL-3.0-or-later
// BYOK key storage. API keys (Anthropic, ElevenLabs) are encrypted at rest with Electron
// safeStorage (Windows DPAPI) and kept in userData. They never leave the main process — the
// renderer only ever asks "is a key set?" and "run this operation", never reads a key back.

import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ElevenLabsKeyStatus } from '../../shared/ipc'

export type SecretName = 'anthropic' | 'elevenlabs'

function keyFilePath(name: SecretName): string {
  return join(app.getPath('userData'), `${name}.key`)
}

export async function setSecret(name: SecretName, key: string): Promise<void> {
  const trimmed = key.trim()
  if (!trimmed) {
    await clearSecret(name)
    return
  }
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  await fs.writeFile(keyFilePath(name), bytes)
}

export async function getSecret(name: SecretName): Promise<string | null> {
  try {
    const bytes = await fs.readFile(keyFilePath(name))
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

export async function hasSecret(name: SecretName): Promise<boolean> {
  return (await getSecret(name)) !== null
}

export async function clearSecret(name: SecretName): Promise<void> {
  try {
    await fs.unlink(keyFilePath(name))
  } catch {
    // already absent
  }
}

// ElevenLabs precedence: the env var wins (dev/.env workflow), the stored key covers installed
// builds where no env exists — same "env still wins" convention as configureBundledFfmpeg.
export async function resolveElevenLabsKey(): Promise<string | null> {
  return process.env.ELEVENLABS_API_KEY || (await getSecret('elevenlabs'))
}

export async function elevenLabsKeyStatus(): Promise<ElevenLabsKeyStatus> {
  if (process.env.ELEVENLABS_API_KEY) return { present: true, source: 'env' }
  return (await hasSecret('elevenlabs')) ? { present: true, source: 'stored' } : { present: false, source: null }
}
