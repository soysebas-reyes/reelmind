// SPDX-License-Identifier: GPL-3.0-or-later
// Downloads a GPL FFmpeg build (ffmpeg + ffprobe) for THIS platform into resources/ffmpeg/ so the
// installer can bundle it. Run on the build machine: `npm run fetch:ffmpeg`. The binaries are
// gitignored (large; redistributed under GPL, matching this project's license). Idempotent.
//
// Sources per platform/arch:
//  - win32-x64:    BtbN — one zip with both .exe binaries + license.txt.
//  - darwin-arm64: ffmpeg.martin-riedl.de — separate ffmpeg/ffprobe zips ("release" channel, static
//                  GPLv3 build with libx264/x265 and h264_videotoolbox). The server rejects HEAD;
//                  always GET. Each resolved download URL has a `.sha256` sidecar (verified below).
//
// Escape hatch if a source goes down: REELO_FFMPEG_SOURCES="url1,url2" replaces the archive list
// for the current platform (same order: an archive containing ffmpeg first, then ffprobe if split).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TARGETS = {
  'win32-x64': {
    label: 'win64 gpl (BtbN)',
    archives: ['https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'],
    binaries: ['ffmpeg.exe', 'ffprobe.exe']
  },
  'darwin-arm64': {
    label: 'macOS arm64 gpl (ffmpeg.martin-riedl.de, release)',
    archives: [
      'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
      'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip'
    ],
    binaries: ['ffmpeg', 'ffprobe']
  }
}

const key = `${process.platform}-${process.arch}`
const target = TARGETS[key]
if (!target) {
  console.error(`No FFmpeg source mapped for ${key}. Supported: ${Object.keys(TARGETS).join(', ')}.`)
  console.error('Add an entry to TARGETS in scripts/fetch-ffmpeg.mjs (or set REELO_FFMPEG_SOURCES).')
  process.exit(1)
}
const archives = process.env.REELO_FFMPEG_SOURCES ? process.env.REELO_FFMPEG_SOURCES.split(',') : target.archives

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'ffmpeg')
const tmpDir = join(root, 'resources', '.ffmpeg-tmp')

if (target.binaries.every((b) => existsSync(join(outDir, b)))) {
  console.log('FFmpeg already present in resources/ffmpeg — skipping. (delete it to re-fetch)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })

/** Download one archive, verify its .sha256 sidecar when the mirror provides one, extract into its own subdir. */
async function fetchAndExtract(url, index) {
  console.log(`Downloading FFmpeg (${target.label})…\n  ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`Download failed: ${res.status} ${res.statusText}`)
    process.exit(1)
  }
  const buf = Buffer.from(await res.arrayBuffer())

  // Integrity: the sidecar lives next to the RESOLVED url (redirect endpoints 404 it). Best-effort —
  // BtbN's `latest` alias has no per-file sidecar, martin-riedl does.
  try {
    const side = await fetch(`${res.url}.sha256`, { redirect: 'follow' })
    if (side.ok) {
      const expected = (await side.text()).trim().split(/\s+/)[0].toLowerCase()
      const actual = createHash('sha256').update(buf).digest('hex')
      if (expected !== actual) {
        console.error(`Checksum mismatch for ${url}\n  expected ${expected}\n  actual   ${actual}`)
        process.exit(1)
      }
      console.log('  sha256 OK')
    }
  } catch {
    // no sidecar reachable — proceed without verification
  }

  const zipPath = join(tmpDir, `archive-${index}.zip`)
  await new Promise((resolve, reject) => {
    const ws = createWriteStream(zipPath)
    ws.on('error', reject)
    ws.on('close', resolve)
    ws.end(buf)
  })

  const extractDir = join(tmpDir, `extract-${index}`)
  mkdirSync(extractDir, { recursive: true })
  // Windows 10+ ships bsdtar (extracts .zip and understands C:\ paths). Use its absolute path:
  // a Git-Bash/MSYS tar earlier in PATH treats "C:\…" as a remote host and fails. macOS bsdtar
  // extracts zip natively.
  const tar =
    process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' })
  rmSync(zipPath, { force: true })
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(p, name)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === name) {
      return p
    }
  }
  return null
}

for (let i = 0; i < archives.length; i++) await fetchAndExtract(archives[i], i)

for (const bin of target.binaries) {
  const found = findFile(tmpDir, bin)
  if (!found) {
    console.error(`Could not find ${bin} in the downloaded archive(s).`)
    process.exit(1)
  }
  const dest = join(outDir, bin)
  copyFileSync(found, dest)
  // The exec bit does not survive copyFileSync from a tar extract on every setup; the packaged app
  // spawns these directly, so make sure they are executable.
  if (process.platform !== 'win32') chmodSync(dest, 0o755)
  console.log(`  → resources/ffmpeg/${bin}`)
}

// GPL compliance when redistributing the binaries: ship the build's license text alongside them.
// BtbN's zip includes one; martin-riedl's zips contain only the binary, so we write an equivalent
// notice pointing at the sources and the build script (both public), as GPLv3 §6 asks.
const license = findFile(tmpDir, 'license.txt')
if (license) {
  copyFileSync(license, join(outDir, 'LICENSE.txt'))
  console.log('  → resources/ffmpeg/LICENSE.txt')
} else {
  const resolvedVersion = /\/(\d+_[^/]+)\//.exec(archives[0])?.[1] ?? 'latest'
  writeFileSync(
    join(outDir, 'LICENSE.txt'),
    [
      'FFmpeg (ffmpeg, ffprobe) — static GPL build for macOS',
      `Build: ${target.label} (${resolvedVersion})`,
      '',
      'These binaries are redistributed under the GNU General Public License v3.',
      'FFmpeg sources:      https://ffmpeg.org/releases/',
      'Build script (open): https://git.martin-riedl.de/ffmpeg/build-script',
      'GPLv3 text:          https://www.gnu.org/licenses/gpl-3.0.txt',
      ''
    ].join('\n'),
    'utf8'
  )
  console.log('  → resources/ffmpeg/LICENSE.txt (generated GPL notice)')
}

rmSync(tmpDir, { recursive: true, force: true })
console.log('Done. FFmpeg bundled for packaging.')
