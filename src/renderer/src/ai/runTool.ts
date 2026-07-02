// SPDX-License-Identifier: GPL-3.0-or-later
// Single entry point for executing an AI/MCP tool in the renderer. Timeline tools go straight to the
// pure executeTool; host-only tools (import_media / import_folder / export / remove_silences — touch
// disk, the media bin, or FFmpeg) are handled here. Both the in-app agent and the MCP bridge call
// this so they behave identically.

import { type FrameCut, type SilenceSeconds, type ToolCallResult, executeTool, expectedPath, silencesToCuts } from '@core'
import { type SyncAnglesInput, getController, useEditorStore } from '../store'

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
  const targetClipId = input.clipId ?? c.getSelectedClipIds()[0]
  if (!targetClipId) return { ok: false, error: 'remove_silences: select a clip first, or pass clipId.' }
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

export async function runEditorTool(name: string, input: unknown): Promise<ToolCallResult> {
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
