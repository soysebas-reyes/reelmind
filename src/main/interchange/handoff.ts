// SPDX-License-Identifier: GPL-3.0-or-later
// Orchestrates an NLE handoff: bakes our color grade + audio enhancement into as few media files as
// possible (one per source, per the pure planBakes), then writes an EDITABLE FCP7 xmeml that opens in
// Premiere / DaVinci Resolve / Final Cut with our look already in the pixels/audio and clips still
// separate. The pure pieces (planBakes / buildBakeCommand / buildFcp7Xml) live in @core; this module is
// the thin Electron/IO layer: resolve paths, spawn ffmpeg, lay out the folder, write files.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  type BakeJob,
  type Clip,
  type InterchangeSource,
  buildBakeCommand,
  buildCapCutDraft,
  buildFcp7Xml,
  clipJobIndex,
  displayName,
  entryFor,
  expectedPath,
  newId,
  planBakes,
  totalFrames,
  windowsPathToFileUrl
} from '@core'
import type { HandoffRequest, HandoffResult } from '../../shared/ipc'
import { ffmpegBinary } from '../ffmpeg/binary'

export interface HandoffHooks {
  onProgress?: (fraction: number) => void
  /** Resolve a clip's logical `lutRef` → absolute .cube path (host-side; keeps @core Electron-free). */
  resolveLut?: (lutRef: string) => string | null
}

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function safeName(s: string): string {
  return (s || 'reelmind').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'reelmind'
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

async function fileExists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    () => true,
    () => false
  )
}

/** Spawn ffmpeg for one bake, reporting 0..1 for THIS job via `-progress pipe:1`. */
function runFfmpeg(args: string[], durationSeconds: number, onFrac?: (f: number) => void): Promise<void> {
  const withProgress = [...args]
  withProgress.splice(withProgress.length - 1, 0, '-progress', 'pipe:1', '-nostats')
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpegBinary(), withProgress, { windowsHide: true })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000)
    })
    if (onFrac && durationSeconds > 0) {
      proc.stdout?.on('data', (d: Buffer) => {
        const m = [...d.toString().matchAll(/out_time_(?:us|ms)=(\d+)/g)]
        if (m.length === 0) return
        const sec = Number(m[m.length - 1][1]) / 1_000_000
        if (Number.isFinite(sec)) onFrac(Math.max(0, Math.min(1, sec / durationSeconds)))
      })
    }
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(stderr.split('\n').filter((l) => l.trim()).slice(-6).join('\n') || `ffmpeg exit ${code}`))
    })
  })
}

const README = (name: string, target: string, warnings: string[], capcutAutoPlaced: boolean): string => {
  const warn = warnings.length ? `\nAvisos de esta exportación:\n${warnings.map((w) => `  - ${w}`).join('\n')}` : ''
  if (target === 'capcut') {
    return [
      `ReelMind → borrador (draft) de CapCut`,
      `Proyecto: ${name}`,
      ``,
      `Esta carpeta ES un borrador de CapCut (draft_content.json + draft_meta_info.json + media/).`,
      capcutAutoPlaced
        ? `Ya la dejamos dentro de la carpeta de borradores de CapCut: abrí CapCut y va a aparecer en`
        : `Para abrirla en CapCut, MOVÉ esta carpeta completa a tu carpeta de borradores de CapCut`,
      capcutAutoPlaced ? `  "Borradores/Drafts". Si no aparece, reiniciá CapCut.` : `  (por defecto en Windows):`,
      capcutAutoPlaced ? `` : `    %LOCALAPPDATA%\\CapCut\\User Data\\Projects\\com.lveditor.draft\\`,
      capcutAutoPlaced ? `` : `  Luego reiniciá CapCut y el borrador aparecerá en "Borradores".`,
      ``,
      `Qué ya está hecho por ReelMind (horneado en los archivos de media/):`,
      `  colorización · realce de audio · sincronización · cambios de ángulo · cortes.`,
      ``,
      `Qué hacés vos en CapCut: subtítulos, efectos, transiciones y el toque creativo.`,
      ``,
      `Importante:`,
      `  - NO muevas ni renombres la subcarpeta media/ — el borrador la referencia por ruta absoluta.`,
      `  - CapCut es experimental como destino: si un borrador no abre, avisanos con tu versión de CapCut.`,
      warn
    ].join('\n')
  }
  return [
    `ReelMind → handoff a editor (${target})`,
    `Proyecto: ${name}`,
    ``,
    `Este paquete contiene un proyecto EDITABLE para tu editor de video:`,
    `  • ${name}.xml  — la secuencia (cortes, tiempos, capas). Importalo desde tu NLE:`,
    `      - Premiere Pro:  Archivo ▸ Importar ▸ ${name}.xml`,
    `      - DaVinci Resolve: File ▸ Import ▸ Timeline ▸ Pre-Conform / Import AAF-EDL-XML`,
    `      - Final Cut Pro (7/X vía traducción): Archivo ▸ Importar ▸ XML`,
    `  • media/  — los clips ya con NUESTRO color + realce de audio aplicados.`,
    `  • luts/   — copias de los LUTs usados (solo referencia; el color YA está horneado).`,
    ``,
    `Qué ya está hecho por ReelMind (horneado en los archivos de media/):`,
    `  colorización · realce de audio · sincronización · cambios de ángulo · cortes.`,
    ``,
    `Qué hacés vos en el editor: subtítulos, efectos, transiciones y el toque creativo.`,
    ``,
    `Notas de importación:`,
    `  - DaVinci Resolve: poné el proyecto al mismo fps ANTES de importar; el audio mono puede`,
    `    entrar como dual-mono (es lo esperado).`,
    `  - Premiere: importa como una secuencia nueva + un bin con la media.`,
    `  - Si algún clip aparece "offline", re-vinculá a la carpeta media/ de este paquete.`,
    warn
  ].join('\n')
}

export async function runHandoff(req: HandoffRequest, hooks: HandoffHooks = {}): Promise<HandoffResult> {
  try {
    const { timeline, manifest, projectDir, projectName, target } = req
    const fps = timeline.fps
    if (totalFrames(timeline) <= 0) {
      return { ok: false, error: 'Nada para exportar — agregá clips a la línea de tiempo primero.' }
    }

    // A CapCut draft must be a DIRECT child of the draft root (CapCut lists immediate subfolders); the
    // xmeml handoff nests under `handoff/` inside the picked folder.
    const isCapCut = target === 'capcut'
    const draftName = `${safeName(projectName)}-${stamp()}`
    const folder = isCapCut ? join(req.outDir, draftName) : join(req.outDir, 'handoff', draftName)
    const mediaDir = join(folder, 'media')
    const lutsDir = join(folder, 'luts')
    await fs.mkdir(mediaDir, { recursive: true })
    await fs.mkdir(lutsDir, { recursive: true })

    const jobs = planBakes(timeline, manifest, { fullLength: req.fullLength })
    const debugLines: string[] = [`target=${target} fps=${fps} jobs=${jobs.length} fullLength=${!!req.fullLength}`, '']

    // Resolve every source path up-front so we can skip offline media cleanly.
    const sources = new Map<string, InterchangeSource>() // bakeKey → source
    const copiedLuts = new Set<string>()
    let fileSeq = 0
    let baked = 0
    let referenced = 0

    const totalBakes = jobs.filter((j) => j.needsBake).length || 1
    let bakeIndex = 0
    const reportOverall = (jobFrac: number): void => hooks.onProgress?.((bakeIndex + jobFrac) / totalBakes)

    for (const job of jobs) {
      const inputPath = expectedPath(manifest, job.mediaRef, projectDir)
      if (!inputPath || !(await fileExists(inputPath))) continue // offline → clip skipped + warned by the builder
      const entry = entryFor(manifest, job.mediaRef)
      const width = entry?.sourceWidth ?? timeline.width
      const height = entry?.sourceHeight ?? timeline.height
      const name = displayName(manifest, job.mediaRef)
      const fileId = `file-${++fileSeq}`

      if (!job.needsBake) {
        referenced++
        sources.set(job.bakeKey, {
          fileId,
          mediaRef: job.mediaRef,
          bakeKey: job.bakeKey,
          name,
          fileUrl: windowsPathToFileUrl(inputPath),
          filePath: inputPath,
          durationFrames: Math.max(1, Math.round((entry?.duration ?? 0) * fps)),
          width,
          height,
          hasAudio: job.hasAudio,
          mediaType: job.mediaType,
          mode: job.mode,
          bakedStartFrame: 0
        })
        continue
      }

      // Bake it.
      const ext = job.mediaType === 'image' ? 'png' : job.mediaType === 'audio' ? 'm4a' : 'mp4'
      const outputPath = join(mediaDir, `${safeName(name)}__${shortHash(job.bakeKey)}.${ext}`)
      const lutPath = job.color?.lutRef && hooks.resolveLut ? hooks.resolveLut(job.color.lutRef) : null
      const { args, durationSeconds } = buildBakeCommand({
        inputPath,
        outputPath,
        mode: job.mode,
        mediaType: job.mediaType,
        fps,
        inFrame: job.inFrame,
        outFrame: job.outFrame,
        color: job.color,
        lutPath,
        audioEnhance: job.audioEnhance,
        flipH: job.flipH,
        flipV: job.flipV,
        speed: job.speed,
        hasAudio: job.hasAudio
      })
      debugLines.push(`# ${fileId} ${job.mode} ${name}`, args.join(' '), '')
      await runFfmpeg(args, durationSeconds, reportOverall)
      bakeIndex++
      reportOverall(0)
      baked++

      // Copy the LUT alongside for the editor's reference (the look is already baked in).
      if (lutPath && !copiedLuts.has(lutPath)) {
        copiedLuts.add(lutPath)
        const base = lutPath.replace(/\\/g, '/').split('/').pop() || 'lut.cube'
        await fs.copyFile(lutPath, join(lutsDir, safeName(base))).catch(() => {})
      }

      // Baked file length in timeline frames (deterministic from the plan; speed baked in for clip mode).
      const bakedFrames =
        job.mode === 'clip'
          ? Math.max(1, Math.round((job.outFrame - job.inFrame) / job.speed))
          : Math.max(1, job.outFrame - job.inFrame)
      sources.set(job.bakeKey, {
        fileId,
        mediaRef: job.mediaRef,
        bakeKey: job.bakeKey,
        name,
        fileUrl: windowsPathToFileUrl(outputPath),
        filePath: outputPath,
        durationFrames: job.mode === 'image' ? Math.max(1, Math.round((entry?.duration ?? 5) * fps)) : bakedFrames,
        width,
        height,
        hasAudio: job.hasAudio,
        mediaType: job.mediaType,
        mode: job.mode,
        bakedStartFrame: job.mode === 'source' ? job.inFrame : 0
      })
    }

    // Clip → source lookup shared by both writers.
    const clipToJob = clipJobIndex(jobs)
    const clipFile = (clip: Clip): InterchangeSource | null => {
      const job: BakeJob | undefined = clipToJob.get(clip.id)
      return job ? sources.get(job.bakeKey) ?? null : null
    }
    const sourceList = [...sources.values()]
    await fs.writeFile(join(folder, 'handoff.ffdebug.txt'), debugLines.join('\n'), 'utf8').catch(() => {})

    if (isCapCut) {
      const { content, meta, warnings, segmentCount } = buildCapCutDraft({
        timeline,
        draftName,
        draftFolderPath: folder,
        draftRootPath: req.outDir,
        sources: sourceList,
        clipFile,
        newId,
        nowMs: Date.now()
      })
      await fs.writeFile(join(folder, 'draft_content.json'), JSON.stringify(content), 'utf8')
      await fs.writeFile(join(folder, 'draft_meta_info.json'), JSON.stringify(meta), 'utf8')
      await fs.writeFile(
        join(folder, 'README.txt'),
        README(projectName || 'ReelMind', target, warnings, !!req.capcutAutoPlaced),
        'utf8'
      )
      return {
        ok: true,
        folder,
        bakedCount: baked,
        referencedCount: referenced,
        clipItemCount: segmentCount,
        warnings,
        isCapCut: true,
        placedInCapCut: !!req.capcutAutoPlaced
      }
    }

    const { xml, warnings, clipItemCount } = buildFcp7Xml({
      timeline,
      sequenceName: projectName || 'ReelMind',
      sources: sourceList,
      clipFile
    })
    const xmlPath = join(folder, `${safeName(projectName)}.xml`)
    await fs.writeFile(xmlPath, xml, 'utf8')
    await fs.writeFile(join(folder, 'README.txt'), README(projectName || 'ReelMind', target, warnings, false), 'utf8')

    return { ok: true, xmlPath, folder, bakedCount: baked, referencedCount: referenced, clipItemCount, warnings }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
