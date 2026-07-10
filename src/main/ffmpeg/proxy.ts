// SPDX-License-Identifier: GPL-3.0-or-later
// Generate a preview PROXY for a video: a 1080p, 8-bit yuv420p, short-GOP H.264 .mp4 that the browser
// can decode by hardware and seek precisely. Camera originals (4K, 10-bit, 4:2:2 XAVC, long-GOP) play
// choppily and seek to the wrong keyframe in a <video> element; the proxy fixes both. Preview uses the
// proxy; the FFmpeg export always uses the original source, so quality is untouched.

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { ProjectFiles, expectedPath, type MediaManifest } from '../../core'
import { ffmpegBinary } from './binary'
import { detectH264Encoder, proxyEncodeArgs, proxyScaleFilter } from './encoders'

/** Recipe version parsed from a proxy filename `…-proxy-v<n>.mp4`, or undefined for a legacy
 *  random-uuid name (which pre-dates versioned filenames → treated as unknown/stale). */
export function parseProxyVersion(filename: string): number | undefined {
  const m = /-proxy-v(\d+)\.mp4$/i.exec(filename)
  return m ? Number(m[1]) : undefined
}

/** Source stem a proxy belongs to: strip the `-proxy-…` suffix from a proxy basename. */
function proxyStem(proxyBasename: string): string {
  return proxyBasename.replace(/-proxy-.*$/i, '')
}

export interface ProxyOptions {
  /** Live stderr line sink for the progress modal (mirrors silence.ts / transcript.ts). */
  onLine?: (line: string) => void
}

/** Preview proxy height. 720p benchmarked ~14% faster than 1080p on a 4K 4:2:2 10-bit source (the
 *  decode dominates) and halves the proxy's own playback cost — plenty of resolution for the preview
 *  canvas; the export always uses the original. */
const PROXY_HEIGHT = 720

/** Transcode `srcPath` to a preview proxy `.mp4` in `outDir`; returns the new path. Downscales to
 *  720 on the long-enough axis, forces 8-bit 4:2:0 (hardware-decodable everywhere), and uses a short
 *  GOP (g=30) so the preview seeks/resumes precisely. Encodes on the GPU when one is usable (NVENC/QSV/
 *  AMF) — that frees the CPU for the 4:2:2 10-bit camera-source decode, the pipeline's real bottleneck —
 *  and skips the H.264 in-loop deblocking filter on the DECODE side (`-skip_loop_filter all`): proxy-
 *  grade fidelity for a measurable decode speedup. Re-encodes audio to AAC so the proxy stays playable.
 *  Measured on a Ryzen 5 4500U + 4K 4:2:2 10-bit source: 48.1 s → 36.5 s per 60 s of footage (−24%),
 *  with the pure-decode floor at 28.8 s. */
export async function generateProxy(
  srcPath: string,
  outDir: string,
  version: number,
  opts: ProxyOptions = {}
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const encoder = await detectH264Encoder()
  // Deterministic, version-keyed name so a regen OVERWRITES the same file instead of accumulating a new
  // random-named orphan on every reopen (the bug this replaces).
  const out = join(outDir, `${basename(srcPath, extname(srcPath))}-proxy-v${version}.mp4`)
  opts.onLine?.(`Encoder de proxy: ${encoder}${encoder === 'libx264' ? ' (CPU)' : ' (GPU)'}`)
  const args = [
    '-y',
    '-skip_loop_filter', 'all', // decode-side speedup; imperceptible at proxy quality
    '-i', srcPath,
    '-vf', proxyScaleFilter(encoder, PROXY_HEIGHT),
    ...proxyEncodeArgs(encoder),
    '-color_range', 'tv', // tag the stream limited-range (VUI) to match the out_range=tv pixels above
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    out
  ]
  // No `-v error`/`-nostats` so ffmpeg emits periodic time=/speed= lines for the progress modal.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    let stderr = ''
    let lineBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      const chunk = d.toString()
      stderr += chunk
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
      if (opts.onLine) {
        lineBuf += chunk
        const lines = lineBuf.split(/\r?\n/)
        lineBuf = lines.pop() ?? ''
        for (const ln of lines) if (ln.trim()) opts.onLine(ln)
      }
    })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (opts.onLine && lineBuf.trim()) opts.onLine(lineBuf)
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n') || `ffmpeg exited ${code}`))
    })
  })
  return out
}

/** Re-link preview proxies that already exist on disk. `generateProxy` writes the proxy .mp4 immediately,
 *  so a proxy survives on disk even if its `proxyPath` was lost / points at a stale or missing file. For
 *  each VIDEO entry: keep a `proxyPath` that still resolves; otherwise look for a `<sourceStem>-proxy-*.mp4`
 *  inside the package's `proxies/` dir (and the package root, for legacy files) and adopt the best match —
 *  preferring the highest recipe version, then the newest mtime. Returns ONLY the entries whose `proxyPath`
 *  should change, WITH the version parsed from the filename so the caller re-stamps `proxyVersion` (else a
 *  still-current proxy that merely moved would be re-flagged stale). Reads the filesystem; writes nothing. */
export async function reconcileProxies(
  manifest: MediaManifest,
  projectDir: string | null
): Promise<{ id: string; proxyPath: string; proxyVersion?: number }[]> {
  if (!projectDir) return []
  const dirs = [join(projectDir, ProjectFiles.proxiesDirectoryName), projectDir]
  const listing: { dir: string; files: string[] }[] = []
  for (const dir of dirs) {
    try {
      listing.push({ dir, files: await fs.readdir(dir) })
    } catch {
      /* dir may not exist (e.g. no proxies/ yet) → skip */
    }
  }
  const relinked: { id: string; proxyPath: string; proxyVersion?: number }[] = []
  for (const e of manifest.entries) {
    if (e.type !== 'video') continue
    // A proxyPath that still points at a real file is fine — leave it untouched.
    if (e.proxyPath) {
      try {
        await fs.stat(e.proxyPath)
        continue
      } catch {
        /* stale path → fall through and try to re-find the proxy on disk */
      }
    }
    const src = expectedPath(manifest, e.id, projectDir)
    if (!src) continue
    const stem = basename(src, extname(src))
    let best: { path: string; version: number | undefined; mtime: number } | null = null
    for (const { dir, files } of listing) {
      for (const f of files) {
        if (!f.startsWith(`${stem}-proxy-`) || !f.toLowerCase().endsWith('.mp4')) continue
        const p = join(dir, f)
        try {
          const st = await fs.stat(p)
          const version = parseProxyVersion(f)
          // Rank: higher version wins; tie → newer mtime.
          if (
            !best ||
            (version ?? -1) > (best.version ?? -1) ||
            ((version ?? -1) === (best.version ?? -1) && st.mtimeMs > best.mtime)
          ) {
            best = { path: p, version, mtime: st.mtimeMs }
          }
        } catch {
          /* unreadable candidate → skip */
        }
      }
    }
    if (best && best.path !== e.proxyPath) relinked.push({ id: e.id, proxyPath: best.path, proxyVersion: best.version })
  }
  return relinked
}

/** Resolve each entry's persisted `proxyRelativePath` (package-relative) into an absolute runtime
 *  `proxyPath` under `projectDir`. Mutates in place. Called on load so the renderer gets ready-to-use
 *  absolute paths and never sees the package-relative form. */
export function resolveProxyPaths(projectDir: string, manifest: MediaManifest): void {
  for (const e of manifest.entries) {
    if (e.proxyRelativePath) e.proxyPath = join(projectDir, e.proxyRelativePath)
  }
}

/** Bring every referenced proxy INTO the package's `proxies/` dir and rewrite each entry to a
 *  package-relative path, clearing the machine-specific absolute path — so a saved project is
 *  self-contained + portable. Copies are idempotent (skip when the deterministic target already exists).
 *  Then sweeps orphan proxy files (old-recipe or legacy random-named, unreferenced) from `proxies/` and the
 *  package root, so reopening no longer accumulates duplicates. Mutates the given manifests in place;
 *  best-effort (per-file IO errors are swallowed so a save never fails on proxy housekeeping). */
export async function consolidateProxies(
  projectDir: string,
  manifests: MediaManifest[],
  currentVersion: number
): Promise<void> {
  const proxiesDir = join(projectDir, ProjectFiles.proxiesDirectoryName)
  await fs.mkdir(proxiesDir, { recursive: true })
  const kept = new Set<string>() // basenames we keep inside proxies/
  for (const manifest of manifests) {
    for (const e of manifest.entries) {
      if (e.type !== 'video' || !e.proxyPath) continue
      const version = e.proxyVersion ?? currentVersion
      const targetName = `${proxyStem(basename(e.proxyPath))}-proxy-v${version}.mp4`
      const target = join(proxiesDir, targetName)
      if (e.proxyPath !== target) {
        try {
          await fs.access(target) // already consolidated → skip the (large) copy
        } catch {
          try {
            await fs.copyFile(e.proxyPath, target)
          } catch {
            continue // source gone / unreadable → leave the entry's absolute path as a fallback
          }
        }
      }
      kept.add(targetName)
      e.proxyRelativePath = `${ProjectFiles.proxiesDirectoryName}/${targetName}`
      e.proxyVersion = version
      e.proxyPath = undefined // do not persist a machine-specific absolute path for an in-package proxy
    }
  }
  // Sweep orphans: unreferenced proxy files that are NOT the current recipe (protects in-flight regens +
  // the kept targets). Legacy random-named files (no parseable version) are always eligible.
  for (const dir of [proxiesDir, projectDir]) {
    let files: string[]
    try {
      files = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const f of files) {
      if (!/-proxy-.*\.mp4$/i.test(f)) continue
      if (dir === proxiesDir && kept.has(f)) continue
      if (parseProxyVersion(f) === currentVersion) continue
      try {
        await fs.rm(join(dir, f))
      } catch {
        /* best-effort */
      }
    }
  }
}
