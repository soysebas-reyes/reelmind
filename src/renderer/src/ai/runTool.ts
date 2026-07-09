// SPDX-License-Identifier: GPL-3.0-or-later
// Single entry point for executing an AI/MCP tool in the renderer. Timeline tools go straight to the
// pure executeTool; host-only tools (import_media / import_folder / export / remove_silences — touch
// disk, the media bin, or FFmpeg) are handled here. Both the in-app agent and the MCP bridge call
// this so they behave identically.

import {
  type ClipType,
  type FrameCut,
  type SilenceSeconds,
  type ToolCallResult,
  executeTool,
  expectedPath,
  manifestToAssetList,
  pickDefaultSilenceTarget,
  silencesToCuts
} from '@core'
import type { NleTarget } from '../../../shared/ipc'
import { type SyncAnglesInput, getController, getFrameCapturer, useEditorStore } from '../store'
import { emit } from '../telemetry/client'

/** Import sources (file paths, http(s) URLs, or folders) through the store and report asset ids. */
async function importAndReport(sources: string[]): Promise<ToolCallResult> {
  try {
    const imported = await useEditorStore.getState().importFromSources(sources)
    return {
      ok: true,
      result: {
        assets: imported.map(({ entry }) => ({
          assetId: entry.id,
          name: entry.name,
          type: entry.type,
          durationSeconds: entry.duration
        }))
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

interface RemoveSilencesInput {
  clipId?: string
  noiseDb?: number
  minDurationSec?: number
  paddingSec?: number
}

/** Detect silences on every audible clip of the selected clip's track and ripple-cut them as one
 *  undo step. Detection runs in main (FFmpeg); the frame mapping + cuts are pure/controller calls. */
async function removeSilences(input: RemoveSilencesInput): Promise<ToolCallResult> {
  const c = getController()
  const { manifest, projectDir } = useEditorStore.getState()
  const tl = c.getTimeline()
  let targetClipId = input.clipId ?? c.getSelectedClipIds()[0]
  if (!targetClipId) {
    // No clipId and no selection: unambiguous only when a single track carries audible clips.
    const picked = pickDefaultSilenceTarget(tl)
    if ('clipId' in picked) {
      targetClipId = picked.clipId
    } else {
      const list = picked.candidates
        .map((cand) => `track ${cand.trackIndex + 1} (${cand.trackId}, firstClipId ${cand.firstClipId})`)
        .join('; ')
      return {
        ok: false,
        error:
          picked.candidates.length === 0
            ? 'remove_silences: no audible clips on the timeline.'
            : `remove_silences: several tracks have audible clips — pass clipId. Candidates: ${list}`
      }
    }
  }
  const track = tl.tracks.find((t) => t.clips.some((cl) => cl.id === targetClipId))
  if (!track) return { ok: false, error: 'remove_silences: clip not found on any track.' }

  const fps = tl.fps
  const noiseDb = input.noiseDb ?? -30
  const minDurationSec = input.minDurationSec ?? 0.5
  const paddingSec = input.paddingSec ?? 0.1

  const cuts: FrameCut[] = []
  for (const clip of track.clips) {
    if (clip.mediaType !== 'video' && clip.mediaType !== 'audio') continue
    const path = expectedPath(manifest, clip.mediaRef, projectDir)
    if (!path) continue
    let silences: SilenceSeconds[]
    try {
      silences = await window.editorBridge.detectSilences({ path, noiseDb, minDurationSec })
    } catch (e) {
      return { ok: false, error: `remove_silences: detection failed — ${e instanceof Error ? e.message : String(e)}` }
    }
    cuts.push(...silencesToCuts(clip, silences, fps, { paddingSec, minSilenceSec: minDurationSec }))
  }

  if (cuts.length === 0) return { ok: true, result: { removedSegments: 0, message: 'No silences found.' } }

  // Apply right-to-left so each left-shifting ripple never invalidates an earlier (leftward) cut.
  cuts.sort((a, b) => b.startFrame - a.startFrame)
  let framesRemoved = 0
  c.runAs('agent', () =>
    c.transact('Remove silences', () => {
      for (const cut of cuts) {
        const cur = c
          .getTimeline()
          .tracks.find((t) => t.id === track.id)
          ?.clips.find((cl) => cut.startFrame >= cl.startFrame && cut.endFrame <= cl.startFrame + cl.durationFrames)
        if (!cur) continue
        const curStart = cur.startFrame
        c.splitClip(cur.id, cut.endFrame) // peel off the right remainder (no-op if the cut ends at clip end)
        const midId = cut.startFrame > curStart ? c.splitClip(cur.id, cut.startFrame) : cur.id
        if (midId) {
          c.rippleDelete([midId])
          framesRemoved += cut.endFrame - cut.startFrame
        }
      }
    })
  )
  return {
    ok: true,
    result: { removedSegments: cuts.length, framesRemoved, secondsRemoved: Number((framesRemoved / fps).toFixed(2)) }
  }
}

async function runEditorToolCore(name: string, input: unknown): Promise<ToolCallResult> {
  if (name === 'import_media') {
    const sources = (input as { sources?: unknown }).sources
    if (!Array.isArray(sources) || sources.length === 0) {
      return { ok: false, error: 'import_media: `sources` must be a non-empty array of paths or URLs' }
    }
    return importAndReport(sources.map(String))
  }

  if (name === 'import_folder') {
    const folderPath = (input as { folderPath?: unknown }).folderPath
    if (typeof folderPath !== 'string' || folderPath.length === 0) {
      return { ok: false, error: 'import_folder: `folderPath` must be a non-empty string' }
    }
    return importAndReport([folderPath])
  }

  if (name === 'export') {
    const outputPath = (input as { outputPath?: unknown }).outputPath
    if (typeof outputPath !== 'string' || outputPath.length === 0) {
      return { ok: false, error: 'export: `outputPath` must be a non-empty string' }
    }
    return useEditorStore.getState().exportToPath(outputPath)
  }

  if (name === 'remove_silences') {
    return removeSilences((input ?? {}) as RemoveSilencesInput)
  }

  if (name === 'extract_audio') {
    const { clipId, assetId } = (input ?? {}) as { clipId?: string; assetId?: string }
    const target = clipId ?? assetId ?? getController().getSelectedClipIds()[0]
    if (!target) return { ok: false, error: 'extract_audio: selecciona un clip o pasa clipId/assetId.' }
    return useEditorStore.getState().extractAudioFromClip(target)
  }

  if (name === 'sync_angles') {
    return useEditorStore.getState().syncAnglesTool((input ?? {}) as SyncAnglesInput)
  }

  if (name === 'segment_by_scripts') {
    const { clipId, scripts, cleanCuts, apply, keepAudioClipId, airMs } = (input ?? {}) as {
      clipId?: string
      scripts?: string
      cleanCuts?: boolean
      apply?: boolean
      keepAudioClipId?: string
      airMs?: number
    }
    const res = await useEditorStore.getState().analyzeTakes(clipId, scripts, cleanCuts ?? false, {
      keepAudioClipId,
      airMs,
      origin: 'agent'
    })
    if (!res.ok) return res
    const summary = (res.result ?? {}) as Record<string, unknown>
    if (apply === false) {
      return { ok: true, result: { ...summary, applied: false, note: 'Plan de tomas listo para revisar en la app.' } }
    }
    await useEditorStore.getState().applyTakesPlan()
    return { ok: true, result: { ...summary, applied: true } }
  }

  if (name === 'new_project') {
    useEditorStore.getState().newProject()
    return { ok: true, result: { message: 'Proyecto nuevo creado.' } }
  }

  if (name === 'open_project') {
    const { dir } = (input ?? {}) as { dir?: string }
    if (typeof dir !== 'string' || dir.length === 0) return { ok: false, error: 'open_project: `dir` es obligatorio.' }
    await useEditorStore.getState().openProject(dir)
    const st = useEditorStore.getState()
    return { ok: true, result: { projectName: st.projectName, projectDir: st.projectDir, assets: st.manifest.entries.length } }
  }

  if (name === 'save_project') {
    const { dir } = (input ?? {}) as { dir?: string }
    await useEditorStore.getState().saveProject(dir)
    const st = useEditorStore.getState()
    if (!st.projectDir) return { ok: false, error: 'save_project: el proyecto no tiene ubicación. Pasá `dir`.' }
    return { ok: true, result: { projectDir: st.projectDir } }
  }

  if (name === 'export_to_nle') {
    const { outDir, target, fullLength } = (input ?? {}) as {
      outDir?: string
      target?: NleTarget
      fullLength?: boolean
    }
    if (typeof outDir !== 'string' || outDir.length === 0) {
      return { ok: false, error: 'export_to_nle: `outDir` (ruta absoluta a una carpeta) es obligatorio.' }
    }
    const st = useEditorStore.getState()
    const res = await window.editorBridge.runHandoff({
      timeline: getController().getTimeline(),
      manifest: st.manifest,
      projectDir: st.projectDir,
      projectName: st.projectName,
      outDir,
      target: target ?? 'universal',
      fullLength
    })
    return res.ok
      ? {
          ok: true,
          result: {
            folder: res.folder,
            xmlPath: res.xmlPath,
            bakedCount: res.bakedCount,
            referencedCount: res.referencedCount,
            clipItemCount: res.clipItemCount,
            warnings: res.warnings
          }
        }
      : { ok: false, error: res.error ?? 'Handoff falló' }
  }

  if (name === 'apply_auto_angles') {
    return useEditorStore.getState().applyAutoAngles()
  }

  if (name === 'transcribe_clip') {
    const { clipId, languageCode, diarize } = (input ?? {}) as {
      clipId?: string
      languageCode?: string
      diarize?: boolean
    }
    const target = clipId ?? getController().getSelectedClipIds()[0]
    if (!target) return { ok: false, error: 'transcribe_clip: selecciona un clip o pasa clipId.' }
    return useEditorStore.getState().transcribeClip(target, { languageCode, diarize })
  }

  if (name === 'get_frame_preview') {
    const { frame, maxWidth, format } = (input ?? {}) as { frame?: number; maxWidth?: number; format?: 'png' | 'jpeg' }
    const c = getController()
    if (typeof frame === 'number') c.seek(Math.max(0, Math.round(frame)))
    const capturer = getFrameCapturer()
    if (!capturer) return { ok: false, error: 'get_frame_preview: preview not available (no editor window).' }
    const shot = await capturer({ maxWidth: maxWidth ?? 640, format: format ?? 'jpeg' })
    if (!shot) return { ok: false, error: 'get_frame_preview: nothing to capture (empty preview).' }
    const comma = shot.dataUrl.indexOf(',')
    const head = shot.dataUrl.slice(0, comma) // e.g. data:image/jpeg;base64
    const base64 = shot.dataUrl.slice(comma + 1)
    const mimeType = head.slice(head.indexOf(':') + 1, head.indexOf(';'))
    return {
      ok: true,
      result: { frame: c.getCurrentFrame(), width: shot.width, height: shot.height, image: { mimeType, base64 } }
    }
  }

  if (name === 'list_assets') {
    const { type } = (input ?? {}) as { type?: ClipType }
    const manifest = useEditorStore.getState().manifest
    return { ok: true, result: { assets: manifestToAssetList(manifest, type), folders: manifest.folders } }
  }

  if (name === 'get_transcript') {
    const transcript = useEditorStore.getState().transcript
    if (!transcript) return { ok: true, result: null }
    const words = transcript.filter((w) => w.type === 'word')
    return {
      ok: true,
      result: {
        wordCount: words.length,
        durationMs: words.length > 0 ? words[words.length - 1].endMs : 0,
        words: transcript
      }
    }
  }

  return executeTool(getController(), name, input)
}

/**
 * The single AI/MCP tool seam (Pilar II). Both the in-app agent (origin 'agent') and the MCP bridge
 * (origin 'mcp') call this, so every tool — current and future — is measured once here with outcome
 * + duration + arg NAMES only (never values). Telemetry never alters the tool result or throws.
 */
export async function runEditorTool(
  name: string,
  input: unknown,
  origin: 'agent' | 'mcp' = 'agent'
): Promise<ToolCallResult> {
  const t0 = performance.now()
  try {
    const res = await runEditorToolCore(name, input)
    emit('tool', `tool.${name}`, {
      origin,
      ok: res.ok,
      ms: Math.round(performance.now() - t0),
      args: input && typeof input === 'object' ? Object.keys(input as object).slice(0, 12).join('|') : typeof input
    })
    return res
  } catch (e) {
    emit('tool', `tool.${name}`, { origin, ok: false, ms: Math.round(performance.now() - t0), error: 'exception' })
    throw e
  }
}
