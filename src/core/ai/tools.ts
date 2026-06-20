// SPDX-License-Identifier: GPL-3.0-or-later
// The AI tool contract: one Zod-validated tool set + one executor over the EditorController.
// This is the single surface both AI transports share — the in-app agent (@anthropic-ai/sdk, BYOK)
// and the embedded MCP server (@modelcontextprotocol/sdk). Every tool call runs as an `agent`
// transaction, so AI edits land in the same undo history as user edits and are tagged accordingly.
//
// Mirrors the spirit of palmier-pro's Agent/Tools/ToolDefinitions.swift, retargeted to our
// EditorController commands. No transport, no network, no key — just validation + dispatch.

import { z } from 'zod'
import { clipEndFrame } from '../model/timeline'
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
        opacity: clip.opacity
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
  tool('undo', 'Undo the last edit.', z.object({}).strict(), (c) => ({ done: c.undo() })),
  tool('redo', 'Redo the last undone edit.', z.object({}).strict(), (c) => ({ done: c.redo() }))
]

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
