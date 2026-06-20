// SPDX-License-Identifier: GPL-3.0-or-later
// Renders a Timeline to a file with one FFmpeg pass. The filter graph is built by the pure
// `buildExportGraph` (in @core) so it mirrors the preview; here we just resolve media paths and
// run the process.

import { spawn } from 'node:child_process'
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

function lastLines(s: string, n: number): string {
  return s.split('\n').filter((l) => l.trim().length > 0).slice(-n).join('\n')
}

export async function exportTimeline(req: ExportTimelineRequest): Promise<ExportTimelineResult> {
  const resolve = (mediaRef: string): string | null => expectedPath(req.manifest, mediaRef, req.projectDir)
  const graph = buildExportGraph(req.timeline, resolve, req.outputPath, req.options)
  if (!graph) return { ok: false, error: 'Nothing to export — add clips to the timeline first.' }

  return new Promise<ExportTimelineResult>((done) => {
    const proc = spawn(ffmpegBinary(), graph.args, { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 24_000) stderr = stderr.slice(-24_000)
    })
    proc.on('error', (e) => done({ ok: false, error: e.message }))
    proc.on('close', (code) => {
      if (code === 0) done({ ok: true, outputPath: req.outputPath, durationSeconds: graph.durationSeconds })
      else done({ ok: false, error: lastLines(stderr, 14) || `ffmpeg exited with code ${code}` })
    })
  })
}
