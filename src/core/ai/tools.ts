// SPDX-License-Identifier: GPL-3.0-or-later
// The AI tool contract: one Zod-validated tool set + one executor over the EditorController.
// This is the single surface both AI transports share — the in-app agent (@anthropic-ai/sdk, BYOK)
// and the embedded MCP server (@modelcontextprotocol/sdk). Every tool call runs as an `agent`
// transaction, so AI edits land in the same undo history as user edits and are tagged accordingly.
//
// Mirrors the spirit of palmier-pro's Agent/Tools/ToolDefinitions.swift, retargeted to our
// EditorController commands. No transport, no network, no key — just validation + dispatch.

import { z } from 'zod'
import { type Clip, clipEndFrame } from '../model/timeline'
import { type EditorController } from '../controller/EditorController'

const clipType = z.enum(['video', 'audio', 'image', 'text', 'lottie'])

export interface ToolDef {
  name: string
  description: string
  input: z.ZodType
  handler: (c: EditorController, input: unknown) => unknown
}

function tool<S extends z.ZodType>(
  name: string,
  description: string,
  input: S,
  handler: (c: EditorController, input: z.infer<S>) => unknown
): ToolDef {
  return { name, description, input, handler: handler as (c: EditorController, input: unknown) => unknown }
}

/** Compact, serializable view of the project for the model to reason over. */
export function summarizeTimeline(c: EditorController): unknown {
  const tl = c.getTimeline()
  return {
    fps: tl.fps,
    width: tl.width,
    height: tl.height,
    totalFrames: c.totalFrames(),
    currentFrame: c.getCurrentFrame(),
    selectedClipIds: c.getSelectedClipIds(),
    canUndo: c.canUndo(),
    canRedo: c.canRedo(),
    tracks: tl.tracks.map((t, index) => ({
      index,
      id: t.id,
      type: t.type,
      muted: t.muted,
      hidden: t.hidden,
      syncLocked: t.syncLocked,
      clips: t.clips.map((clip) => ({
        id: clip.id,
        mediaRef: clip.mediaRef,
        mediaType: clip.mediaType,
        startFrame: clip.startFrame,
        endFrame: clipEndFrame(clip),
        durationFrames: clip.durationFrames,
        trimStartFrame: clip.trimStartFrame,
        trimEndFrame: clip.trimEndFrame,
        speed: clip.speed,
        volume: clip.volume,
        opacity: clip.opacity,
        color: clip.color,
        linkGroupId: clip.linkGroupId
      }))
    }))
  }
}

export const editorTools: ToolDef[] = [
  tool(
    'get_timeline',
    'Return the current project state: tracks, clips (with ids and frame positions), fps, resolution, playhead, and selection. Call this first to learn clip and track ids before editing.',
    z.object({}).strict(),
    (c) => summarizeTimeline(c)
  ),
  tool(
    'add_track',
    'Add a new track of the given type. Visual tracks (video/image/text/lottie) are kept above audio tracks. Returns the new track id.',
    z.object({ type: clipType, atIndex: z.number().int().nonnegative().optional() }),
    (c, input) => ({ trackId: c.addTrack(input.type, input.atIndex) })
  ),
  tool(
    'remove_track',
    'Remove a track (and its clips) by id.',
    z.object({ trackId: z.string() }),
    (c, input) => {
      c.removeTrack(input.trackId)
      return { ok: true }
    }
  ),
  tool(
    'set_track_flag',
    'Toggle or set a track flag: muted, hidden, or syncLocked. Omit `value` to toggle.',
    z.object({
      trackId: z.string(),
      flag: z.enum(['muted', 'hidden', 'syncLocked']),
      value: z.boolean().optional()
    }),
    (c, input) => {
      if (input.flag === 'muted') c.setTrackMuted(input.trackId, input.value)
      else if (input.flag === 'hidden') c.setTrackHidden(input.trackId, input.value)
      else c.setTrackSyncLocked(input.trackId, input.value)
      return { ok: true }
    }
  ),
  tool(
    'add_clip',
    'Add a clip from a media asset to a track at a frame position (overwrites whatever it lands on). Returns the new clip id, or an error if the track is missing.',
    z.object({
      trackId: z.string(),
      mediaRef: z.string(),
      startFrame: z.number().int().nonnegative(),
      durationFrames: z.number().int().positive(),
      mediaType: clipType.optional(),
      trimStartFrame: z.number().int().nonnegative().optional(),
      trimEndFrame: z.number().int().nonnegative().optional(),
      speed: z.number().positive().optional(),
      volume: z.number().min(0).optional()
    }),
    (c, input) => {
      const clipId = c.addClip(input)
      return clipId ? { clipId } : { error: 'Track not found' }
    }
  ),
  tool(
    'move_clip',
    'Move a clip to a track and start frame (overwrites at the destination). The destination track must be type-compatible.',
    z.object({ clipId: z.string(), toTrackId: z.string(), toFrame: z.number().int().nonnegative() }),
    (c, input) => {
      c.moveClip(input.clipId, input.toTrackId, input.toFrame)
      return { ok: true }
    }
  ),
  tool(
    'trim_clip',
    'Set a clip’s source-frame trims (head and tail). The clip resizes in place; neighbors are not shifted.',
    z.object({ clipId: z.string(), trimStartFrame: z.number().int().nonnegative(), trimEndFrame: z.number().int().nonnegative() }),
    (c, input) => {
      c.trimClip(input.clipId, input.trimStartFrame, input.trimEndFrame)
      return { ok: true }
    }
  ),
  tool(
    'split_clip',
    'Split a clip at a timeline frame inside its body. Returns the new right-half clip id, or null if the frame is outside the clip.',
    z.object({ clipId: z.string(), atFrame: z.number().int().nonnegative() }),
    (c, input) => ({ rightId: c.splitClip(input.clipId, input.atFrame) })
  ),
  tool(
    'remove_clips',
    'Remove clips by id (leaves gaps).',
    z.object({ clipIds: z.array(z.string()).min(1) }),
    (c, input) => {
      c.removeClips(input.clipIds)
      return { ok: true }
    }
  ),
  tool(
    'ripple_delete',
    'Remove clips and close the gaps; sync-locked tracks shift to stay aligned. Refuses if a sync-locked follower cannot absorb the shift.',
    z.object({ clipIds: z.array(z.string()).min(1) }),
    (c, input) => c.rippleDelete(input.clipIds)
  ),
  tool(
    'set_clip_speed',
    'Change a clip’s playback speed (recomputes its duration and ripples the contiguous chain after it).',
    z.object({ clipId: z.string(), speed: z.number().positive() }),
    (c, input) => {
      c.setClipSpeed(input.clipId, input.speed)
      return { ok: true }
    }
  ),
  tool(
    'set_clip_properties',
    'Edit appearance/behavior fields on a clip: volume, opacity, fade in/out (frames), speed.',
    z.object({
      clipId: z.string(),
      volume: z.number().min(0).optional(),
      opacity: z.number().min(0).max(1).optional(),
      fadeInFrames: z.number().int().nonnegative().optional(),
      fadeOutFrames: z.number().int().nonnegative().optional(),
      speed: z.number().positive().optional()
    }),
    (c, input) => {
      const { clipId, ...props } = input
      c.setClipProperties(clipId, props)
      return { ok: true }
    }
  ),
  tool(
    'set_clip_color',
    'Color-grade a clip (Phase 9.5). All fields optional and MERGE onto the current grade — omitted fields stay unchanged. Ranges: exposure -2..2 (stops), brightness -1..1, contrast 0..2 (1=neutral), saturation 0..2 (1=neutral; 0.88 ≈ Lumetri saturation 88), temperature -100..100 (negative=cooler), tint -100..100 (positive=magenta), hue -180..180 deg, gamma 0.1..3, highlights/shadows/whites/blacks -100..100 (0=neutral), lutIntensity 0..1.',
    z.object({
      clipId: z.string(),
      exposure: z.number().min(-2).max(2).optional(),
      brightness: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(0).max(2).optional(),
      saturation: z.number().min(0).max(2).optional(),
      temperature: z.number().min(-100).max(100).optional(),
      tint: z.number().min(-100).max(100).optional(),
      hue: z.number().min(-180).max(180).optional(),
      gamma: z.number().min(0.1).max(3).optional(),
      highlights: z.number().min(-100).max(100).optional(),
      shadows: z.number().min(-100).max(100).optional(),
      whites: z.number().min(-100).max(100).optional(),
      blacks: z.number().min(-100).max(100).optional(),
      lutIntensity: z.number().min(0).max(1).optional()
    }),
    (c, input) => {
      const { clipId, ...patch } = input
      c.setClipColor(clipId, patch)
      return { ok: true }
    }
  ),
  tool(
    'seek',
    'Move the playhead to a frame.',
    z.object({ frame: z.number().int().nonnegative() }),
    (c, input) => {
      c.seek(input.frame)
      return { ok: true, currentFrame: c.getCurrentFrame() }
    }
  ),
  tool(
    'set_resolution',
    'Set the project output resolution in pixels.',
    z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    (c, input) => {
      c.setResolution(input.width, input.height)
      return { ok: true }
    }
  ),
  tool(
    'set_fps',
    'Set the project frame rate.',
    z.object({ fps: z.number().positive() }),
    (c, input) => {
      c.setFps(input.fps)
      return { ok: true }
    }
  ),
  tool(
    'import_media',
    'Import media into the bin from local file paths or http(s) URLs (e.g. a clip generated by Higgsfield), so it can be placed with add_clip. Returns the new asset id(s) — use `assetId` as `mediaRef` in add_clip. NOTE: executed by the host app (it touches the filesystem and the media bin), not the timeline core.',
    z.object({ sources: z.array(z.string()).min(1) }),
    () => {
      throw new Error('import_media is executed by the host app, not the core executor')
    }
  ),
  tool(
    'import_folder',
    'Import every supported media file in a local folder into the bin (non-recursive), so the clips can be placed with add_clip. Returns the new asset id(s) — use `assetId` as `mediaRef` in add_clip. NOTE: executed by the host app (filesystem + media bin), not the timeline core.',
    z.object({ folderPath: z.string().min(1) }),
    () => {
      throw new Error('import_folder is executed by the host app, not the core executor')
    }
  ),
  tool(
    'export',
    'Render the current timeline to a video file at `outputPath` (an absolute path, e.g. D:\\\\out\\\\video.mp4). Set the project resolution first with set_resolution if a specific size is wanted. Returns the output path and duration. NOTE: executed by the host app (FFmpeg), not the timeline core.',
    z.object({ outputPath: z.string().min(1) }),
    () => {
      throw new Error('export is executed by the host app, not the core executor')
    }
  ),
  tool(
    'remove_silences',
    'Detect and cut silent gaps from the clips on the track of the selected clip (or the clip given by `clipId`). Uses FFmpeg silence detection, then ripple-deletes the silent spans as a single undo step. Optional: noiseDb (silence threshold, default -30), minDurationSec (shortest silence to cut, default 0.5), paddingSec (audio kept around speech, default 0.1). NOTE: executed by the host app (FFmpeg + filesystem), not the timeline core.',
    z.object({
      clipId: z.string().optional(),
      noiseDb: z.number().optional(),
      minDurationSec: z.number().positive().optional(),
      paddingSec: z.number().min(0).optional()
    }),
    () => {
      throw new Error('remove_silences is executed by the host app, not the core executor')
    }
  ),
  tool(
    'extract_audio',
    "Extract a video's audio track into a NEW audio asset in the bin. Pass `clipId` (a timeline clip) or `assetId` (a bin asset); defaults to the selected clip. Returns the new audio assetId. NOTE: executed by the host app (FFmpeg + media bin), not the timeline core.",
    z.object({ clipId: z.string().optional(), assetId: z.string().optional() }),
    () => {
      throw new Error('extract_audio is executed by the host app, not the core executor')
    }
  ),
  tool(
    'sync_angles',
    "Align two camera angles of the SAME take by their audio (cross-correlation): place them on two video tracks at the matching time offset, mute both videos, add the kept angle's audio on its own track (continuous audio for cutting between angles), and tag both clips with a shared linkGroupId. Pass `clipIds` (exactly 2 video clips already on the timeline) or use the current selection; `keepAudioOf` ('first'|'second', default 'first') chooses which angle's audio to keep; `autoColor` (default true) applies the Guillermo Frontal/Lateral LUT per angle. Returns offsetSeconds + confidence. NOTE: executed by the host app (FFmpeg + filesystem), not the timeline core.",
    z.object({
      clipIds: z.array(z.string()).length(2).optional(),
      keepAudioOf: z.enum(['first', 'second']).optional(),
      autoColor: z.boolean().optional()
    }),
    () => {
      throw new Error('sync_angles is executed by the host app, not the core executor')
    }
  ),
  tool('undo', 'Undo the last edit.', z.object({}).strict(), (c) => ({ done: c.undo() })),
  tool('redo', 'Redo the last undone edit.', z.object({}).strict(), (c) => ({ done: c.redo() })),

  // ── Transcript tools (host-executed) ──────────────────────────────────────────────────────────
  tool(
    'transcribe_clip',
    'Transcribe a video or audio clip with ElevenLabs Scribe and return word-level timestamps in ms. ' +
      'Requires ELEVENLABS_API_KEY in the environment. ' +
      'The transcript is stored in the project and can be read with get_transcript.',
    z.object({
      clipId: z.string().optional().describe('Clip id to transcribe. Defaults to the first selected clip.'),
      languageCode: z
        .string()
        .optional()
        .describe('BCP-47 language code (e.g. "es", "en"). Omit for auto-detect.'),
      diarize: z.boolean().optional().describe('Identify individual speakers (who said what).')
    }),
    () => {
      throw new Error('transcribe_clip is executed by the host app, not the core executor')
    }
  ),
  tool(
    'get_transcript',
    'Return the current project transcript (word-level timestamps in ms) that was generated by transcribe_clip. ' +
      'Returns null if no transcript has been generated yet.',
    z.object({}).strict(),
    () => {
      throw new Error('get_transcript is executed by the host app, not the core executor')
    }
  ),

  // ── Multicam angle switching ──────────────────────────────────────────────────────────────────
  tool(
    'cut_to_angle',
    'Create a multicam cut: for the time range [fromMs, toMs], show the specified angle and hide the other. ' +
      'Both clips are split at the boundaries; the hidden angle gets opacity=0 for that segment. ' +
      'Use get_timeline to find frontalClipId and lateralClipId (linked clips share a linkGroupId). ' +
      'Combine multiple calls to build a full multicam sequence.',
    z.object({
      frontalClipId: z.string().describe('Clip id of the frontal-angle video.'),
      lateralClipId: z.string().describe('Clip id of the lateral-angle video.'),
      fromMs: z.number().nonnegative().describe('Range start in milliseconds from project start.'),
      toMs: z.number().positive().describe('Range end in milliseconds.'),
      angle: z.enum(['frontal', 'lateral']).describe('Which angle to show for this range.')
    }),
    (c, input) => {
      const fps = c.getTimeline().fps
      const fromFrame = Math.round((input.fromMs / 1000) * fps)
      const toFrame = Math.round((input.toMs / 1000) * fps)
      if (fromFrame >= toFrame) return { ok: false, error: 'fromMs must be less than toMs' }

      const findClip = (id: string): Clip | null => {
        for (const track of c.getTimeline().tracks) {
          const cl = track.clips.find((x) => x.id === id)
          if (cl) return cl
        }
        return null
      }

      const applyCut = (clipId: string, show: boolean): void => {
        const clip = findClip(clipId)
        if (!clip) return
        const clipEnd = clip.startFrame + clip.durationFrames
        if (clip.startFrame >= toFrame || clipEnd <= fromFrame) return // no overlap

        // Split at left boundary → segId becomes the piece starting at fromFrame (or clip.startFrame)
        let segId = clipId
        if (clip.startFrame < fromFrame) {
          const rightId = c.splitClip(clipId, fromFrame)
          if (rightId) segId = rightId
        }
        // Split at right boundary — we only need the left (segId) piece's opacity
        c.splitClip(segId, toFrame)
        c.setClipProperties(segId, { opacity: show ? 1 : 0 })
      }

      c.runAs('agent', () =>
        c.transact(
          `Cut to ${input.angle} (${Math.round(input.fromMs / 1000)}s–${Math.round(input.toMs / 1000)}s)`,
          () => {
            applyCut(input.frontalClipId, input.angle === 'frontal')
            applyCut(input.lateralClipId, input.angle === 'lateral')
          }
        )
      )
      return { ok: true }
    }
  )
]

/** Tools that the core executor cannot run — the host (renderer) must intercept these. */
export const HOST_EXECUTED_TOOLS: ReadonlySet<string> = new Set([
  'import_media',
  'import_folder',
  'export',
  'remove_silences',
  'extract_audio',
  'sync_angles',
  'transcribe_clip',
  'get_transcript'
])

export const editorToolsByName: Map<string, ToolDef> = new Map(editorTools.map((t) => [t.name, t]))

export interface ToolCallResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** Validate `input` against the named tool's schema and dispatch to the EditorController.
 *  All mutations run as one `agent`-tagged undo step. Returns a serializable result. */
export function executeTool(controller: EditorController, name: string, input: unknown): ToolCallResult {
  const def = editorToolsByName.get(name)
  if (!def) return { ok: false, error: `Unknown tool: ${name}` }
  const parsed = def.input.safeParse(input ?? {})
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return { ok: false, error: `Invalid input for ${name}: ${msg}` }
  }
  try {
    const result = controller.runAs('agent', () => def.handler(controller, parsed.data))
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Tool metadata for a transport to advertise (name + description + Zod input schema). A transport
 *  converts `input` to its own schema format (e.g. JSON Schema for Anthropic tools / MCP). */
export function toolManifest(): { name: string; description: string; input: z.ZodType }[] {
  return editorTools.map((t) => ({ name: t.name, description: t.description, input: t.input }))
}

export interface JsonSchemaTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Transport-ready tool list with JSON-Schema inputs. The shape matches both the Anthropic
 *  `tools` array (`name`/`description`/`input_schema`) and MCP's `tools/list` (`inputSchema`):
 *  the in-app agent and the embedded MCP server build their advertised tools from this. */
export function toJsonSchemaTools(): JsonSchemaTool[] {
  return editorTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input) as Record<string, unknown>
  }))
}
