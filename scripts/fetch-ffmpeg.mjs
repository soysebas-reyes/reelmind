// SPDX-License-Identifier: GPL-3.0-or-later
// Downloads a GPL Windows FFmpeg build (ffmpeg.exe + ffprobe.exe) into resources/ffmpeg/ so the
// installer can bundle them. Run on the build machine: `npm run fetch:ffmpeg`. The binaries are
// gitignored (large; redistributed under GPL, matching this project's license). Idempotent.

import { execFileSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'ffmpeg')
const tmpZip = join(root, 'resources', '.ffmpeg-tmp.zip')
const tmpDir = join(root, 'resources', '.ffmpeg-tmp')

if (existsSync(join(outDir, 'ffmpeg.exe')) && existsSync(join(outDir, 'ffprobe.exe'))) {
  console.log('FFmpeg already present in resources/ffmpeg — skipping. (delete it to re-fetch)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })

console.log(`Downloading FFmpeg (win64 gpl)…\n  ${SOURCE}`)
const res = await fetch(SOURCE, { redirect: 'follow' })
if (!res.ok) {
  console.error(`Download failed: ${res.status} ${res.statusText}`)
  process.exit(1)
}
const buf = Buffer.from(await res.arrayBuffer())
await new Promise((resolve, reject) => {
  const ws = createWriteStream(tmpZip)
  ws.on('error', reject)
  ws.on('close', resolve)
  ws.end(buf)
})

console.log('Extracting…')
rmSync(tmpDir, { recursive: true, force: true })
mkdirSync(tmpDir, { recursive: true })
// Windows 10+ ships tar.exe, which extracts .zip archives.
execFileSync('tar', ['-xf', tmpZip, '-C', tmpDir], { stdio: 'inherit' })

function findExe(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findExe(p, name)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === name) {
      return p
    }
  }
  return null
}

for (const exe of ['ffmpeg.exe', 'ffprobe.exe']) {
  const found = findExe(tmpDir, exe)
  if (!found) {
    console.error(`Could not find ${exe} in the archive.`)
    process.exit(1)
  }
  copyFileSync(found, join(outDir, exe))
  console.log(`  → resources/ffmpeg/${exe}`)
}

rmSync(tmpZip, { force: true })
rmSync(tmpDir, { recursive: true, force: true })
console.log('Done. FFmpeg bundled for packaging.')
