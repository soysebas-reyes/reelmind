// SPDX-License-Identifier: GPL-3.0-or-later
// Renders a Timeline to a file with one FFmpeg pass. The filter graph is built by the pure
// `buildExportGraph` (in @core) so it mirrors the preview; here we just resolve media paths and
// run the process.

import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { type ExportOptions, type MediaManifest, type Timeline, buildExportGraph, expectedPath } from '@core'
import { ffmpegBinary } from './binary'

export interface ExportTimelineRequest {
  timeline: Timeline
  manifest: MediaManifest
  projectDir: string | null
  outputPath: string
  options?: ExportOptions
}

export interface ExportTimelineResult {
  ok: boolean
  outputPath?: string
  error?: string
  durationSeconds?: number
}

export interface ExportHooks {
  onProgress?: (fraction: number) => void
  /** Resolve a clip's logical `lutRef` → absolute .cube path (host-side; keeps this module Electron-free). */
  resolveLut?: (lutRef: string) => string | null
}

function lastLines(s: string, n: number): string {
  return s.split('\n').filter((l) => l.trim().length > 0).slice(-n).join('\n')
}

export async function exportTimeline(req: ExportTimelineRequest, hooks: ExportHooks = {}): Promise<ExportTimelineResult> {
  const resolve = (mediaRef: string): string | null => expectedPath(req.manifest, mediaRef, req.projectDir)
  // Pass the LUT resolver through so the export bakes in the .cube (the dominant look) instead of
  // silently dropping it — preview == export.
  const graph = buildExportGraph(req.timeline, resolve, req.outputPath, req.options, hooks.resolveLut)
  if (!graph) return { ok: false, error: 'Nothing to export — add clips to the timeline first.' }

  // `+faststart` moves the moov atom to the front (more compatible / streamable); `-progress pipe:1`
  // emits machine-readable progress on stdout so the UI can show a real percentage for long renders.
  const args = [...graph.args]
  args.splice(args.length - 1, 0, '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats')
  const dur = graph.durationSeconds

  // Diagnostics sidecar: the exact graph this render will run, written BEFORE spawning so an OOM/crash
  // still leaves the evidence. `videoMode: concat` = the memory-safe sequential path; `overlay` on a
  // many-clip timeline is the known OOM shape. If this file is missing after an export, the running
  // build predates the concat fast path (stale main process / old installed build).
  const debugPath = `${req.outputPath}.ffdebug.txt`
  const debugBody = [
    `videoMode=${graph.videoMode}  visualClips=${graph.visualClipCount}  audioClips=${graph.audioClipCount}`,
    `inputs=${graph.inputCount}  frames=${graph.totalFrames}  duration=${graph.durationSeconds.toFixed(2)}s  filterComplexChars=${graph.filterComplex.length}`,
    '',
    '--- args ---',
    args.join(' ')
  ].join('\n')
  try {
    await writeFile(debugPath, debugBody, 'utf8')
  } catch {
    /* diagnostics only — never block the render */
  }
  console.log(
    `[reelo] export: videoMode=${graph.videoMode} visualClips=${graph.visualClipCount} audioClips=${graph.audioClipCount} inputs=${graph.inputCount} → ${debugPath}`
  )

  return new Promise<ExportTimelineResult>((done) => {
    const proc = spawn(ffmpegBinary(), args, { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 24_000) stderr = stderr.slice(-24_000)
    })
    if (hooks.onProgress && dur > 0) {
      const report = hooks.onProgress
      proc.stdout?.on('data', (d: Buffer) => {
        // FFmpeg progress reports out_time in microseconds (both out_time_us and the legacy out_time_ms).
        const matches = [...d.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)]
        if (matches.length === 0) return
        const seconds = Number(matches[matches.length - 1][1]) / 1_000_000
        if (Number.isFinite(seconds)) report(Math.max(0, Math.min(1, seconds / dur)))
      })
    }
    proc.on('error', (e) => done({ ok: false, error: e.message }))
    proc.on('close', (code) => {
      if (code === 0) done({ ok: true, outputPath: req.outputPath, durationSeconds: graph.durationSeconds })
      else {
        const tail = lastLines(stderr, 14) || `ffmpeg exited with code ${code}`
        done({
          ok: false,
          error: `${tail}\n[modo=${graph.videoMode} · clips=${graph.visualClipCount}v/${graph.audioClipCount}a · diagnóstico: ${debugPath}]`
        })
      }
    })
  })
}
