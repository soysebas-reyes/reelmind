// SPDX-License-Identifier: GPL-3.0-or-later
// Generate a preview PROXY for a video: a 1080p, 8-bit yuv420p, short-GOP H.264 .mp4 that the browser
// can decode by hardware and seek precisely. Camera originals (4K, 10-bit, 4:2:2 XAVC, long-GOP) play
// choppily and seek to the wrong keyframe in a <video> element; the proxy fixes both. Preview uses the
// proxy; the FFmpeg export always uses the original source, so quality is untouched.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { expectedPath, type MediaManifest } from '../../core'
import { ffmpegBinary } from './binary'

export interface ProxyOptions {
  /** Live stderr line sink for the progress modal (mirrors silence.ts / transcript.ts). */
  onLine?: (line: string) => void
}

/** Transcode `srcPath` to a preview proxy `.mp4` in `outDir`; returns the new path. Downscales to
 *  1080 on the long-enough axis, forces yuv420p 8-bit, and uses a short GOP (g=30 + scene-cut) so the
 *  preview seeks/resumes precisely. Re-encodes audio to AAC so a single-clip proxy stays playable. */
export async function generateProxy(srcPath: string, outDir: string, opts: ProxyOptions = {}): Promise<string> {
  await fs.mkdir(outDir, { recursive: true })
  const out = join(outDir, `${basename(srcPath, extname(srcPath))}-proxy-${randomUUID()}.mp4`)
  const args = [
    '-y',
    '-i',
    srcPath,
    '-vf',
    'scale=-2:1080', // downscale to 1080 tall (even width); harmless slight upscale for tiny sources
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p', // 8-bit 4:2:0 → hardware-decodable everywhere
    '-g',
    '30', // short GOP → frequent keyframes → precise seeking / clean pause-resume
    '-keyint_min',
    '15',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
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

/** Re-link preview proxies that already exist on disk in `projectDir`. `generateProxy` writes the proxy
 *  .mp4 immediately, so a proxy survives on disk even if its `proxyPath` was lost from a saved/reopened
 *  manifest (or now points at a stale/missing file). For each VIDEO entry: keep a `proxyPath` that still
 *  resolves; otherwise look for a `<sourceStem>-proxy-*.mp4` beside the project and adopt the newest match.
 *  Returns ONLY the entries whose `proxyPath` should change, so a reopened project reuses an existing proxy
 *  instead of prompting to regenerate. Reads the filesystem; writes nothing. */
export async function reconcileProxies(
  manifest: MediaManifest,
  projectDir: string | null
): Promise<{ id: string; proxyPath: string }[]> {
  if (!projectDir) return []
  let dirFiles: string[]
  try {
    dirFiles = await fs.readdir(projectDir)
  } catch {
    return []
  }
  const relinked: { id: string; proxyPath: string }[] = []
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
    const candidates = dirFiles.filter((f) => f.startsWith(`${stem}-proxy-`) && f.toLowerCase().endsWith('.mp4'))
    let best: { path: string; mtime: number } | null = null
    for (const name of candidates) {
      const p = join(projectDir, name)
      try {
        const st = await fs.stat(p)
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs }
      } catch {
        /* unreadable candidate → skip */
      }
    }
    if (best && best.path !== e.proxyPath) relinked.push({ id: e.id, proxyPath: best.path })
  }
  return relinked
}
