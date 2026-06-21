// SPDX-License-Identifier: GPL-3.0-or-later
// The single command API over a Timeline. Ported in spirit from palmier-pro's
// EditorViewModel (+ClipMutations / +Ripple / +Tracks), GPL-3.0, © Palmier, Inc.
//
// Upstream registers one timeline-swap undo per atomic action. We do the same with
// Immer patches: every command runs inside one transaction and pushes a single
// {patches, inverse} entry, so one command == one undo step. Compound operations
// (overwrite = clear + insert, ripple-delete = remove + shift, split-inside-clear)
// nest their mutations into the outer transaction and still collapse to one step.
//
// The UI, the in-app agent, and the embedded MCP server are all meant to call THESE
// commands — never to mutate the timeline directly. Agent-driven runs tag their undo
// entries `agent` via `runAs('agent', …)`.

import { type Patch, applyPatches, current, enablePatches, produceWithPatches } from 'immer'
import { Snap, newId, sround } from '../constants'
import { type ClipType, isCompatible } from '../model/clipType'
import { type Interpolation, lerpNumber, sampleTrack } from '../model/keyframe'
import { type ColorAdjustments, IDENTITY_COLOR, mergeColor } from '../model/color'
import {
  type Clip,
  type Crop,
  type TextStyle,
  type Timeline,
  type Track,
  type Transform,
  clampFadesToDuration,
  clampKeyframesToDuration,
  clipEndFrame,
  contiguousClipIds,
  makeClip,
  makeTimeline,
  makeTrack,
  setClipDuration,
  totalFrames
} from '../model/timeline'
import {
  type ClipShift,
  type FrameRange,
  computeRippleShifts,
  computeRippleShiftsForRanges,
  computeRipplePush,
  frameRangeLength,
  mergeRanges
} from '../engines/rippleEngine'
import { type OverwriteAction, computeOverwrite } from '../engines/overwriteEngine'
import { type SnapResult, type SnapState, collectTargets, findSnap } from '../engines/snapEngine'

enablePatches()

export type CommandOrigin = 'user' | 'agent'

/** `edit` = the timeline changed (undoable). `view` = playhead/selection moved.
 *  `load` = the whole project was replaced (undo history reset). */
export type EditorChangeKind = 'edit' | 'view' | 'load'
export type EditorListener = (kind: EditorChangeKind) => void

interface UndoEntry {
  patches: Patch[]
  inverse: Patch[]
  label: string
  origin: CommandOrigin
}

export interface RippleOutcome {
  ok: boolean
  reason?: string
  removedFrames: number
  shiftedClips: number
}

export interface EditorSnapshot {
  timeline: Timeline
  currentFrame: number
  selectedClipIds: string[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  undoOrigin: CommandOrigin | null
  redoOrigin: CommandOrigin | null
}

export interface AddClipArgs {
  trackId: string
  mediaRef: string
  startFrame: number
  durationFrames: number
  id?: string
  mediaType?: ClipType
  sourceClipType?: ClipType
  trimStartFrame?: number
  trimEndFrame?: number
  speed?: number
  volume?: number
}

export interface MoveSpec {
  clipId: string
  toTrackId: string
  toFrame: number
}

/** Whitelisted appearance/behavior fields editable through `setClipProperties`.
 *  Structural fields (id, mediaRef, start/duration/trim) have dedicated commands. */
export interface ClipPropertyEdit {
  volume?: number
  opacity?: number
  speed?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  fadeInInterpolation?: Interpolation
  fadeOutInterpolation?: Interpolation
  transform?: Transform
  crop?: Crop
  color?: ColorAdjustments
  textContent?: string
  textStyle?: TextStyle
}

const EDITABLE_KEYS: (keyof ClipPropertyEdit)[] = [
  'volume',
  'opacity',
  'speed',
  'fadeInFrames',
  'fadeOutFrames',
  'fadeInInterpolation',
  'fadeOutInterpolation',
  'transform',
  'crop',
  'color',
  'textContent',
  'textStyle'
]

// MARK: - Module helpers (operate on a draft or plain timeline)

interface ClipLoc {
  trackIndex: number
  clipIndex: number
}

function locateClip(tl: Timeline, id: string): ClipLoc | null {
  for (let ti = 0; ti < tl.tracks.length; ti++) {
    const ci = tl.tracks[ti].clips.findIndex((c) => c.id === id)
    if (ci >= 0) return { trackIndex: ti, clipIndex: ci }
  }
  return null
}

function trackIndexById(tl: Timeline, trackId: string): number {
  return tl.tracks.findIndex((t) => t.id === trackId)
}

function sortTrack(track: Track): void {
  track.clips.sort((a, b) => a.startFrame - b.startFrame)
}

/** First audio track's index, or `tracks.length` if there is none. Visual tracks
 *  must sit at or above this line; audio at or below it. */
function firstAudioIndex(tl: Timeline): number {
  const i = tl.tracks.findIndex((t) => t.type === 'audio')
  return i < 0 ? tl.tracks.length : i
}

function partitionIndex(tl: Timeline, type: ClipType, requested: number): number {
  const bounded = Math.max(0, Math.min(requested, tl.tracks.length))
  const fa = firstAudioIndex(tl)
  return type === 'audio' ? Math.max(bounded, fa) : Math.min(bounded, fa)
}

function applyShifts(tl: Timeline, shifts: ClipShift[]): number {
  let applied = 0
  for (const s of shifts) {
    const loc = locateClip(tl, s.clipId)
    if (!loc) continue
    tl.tracks[loc.trackIndex].clips[loc.clipIndex].startFrame = s.newStartFrame
    applied += 1
  }
  return applied
}

/** Deep, proxy-free copy. Call with a plain object (use Immer `current()` on a draft). */
function cloneClip(c: Clip): Clip {
  return structuredClone(c)
}

function applyOverwriteAction(track: Track, action: OverwriteAction): void {
  switch (action.kind) {
    case 'remove':
      track.clips = track.clips.filter((c) => c.id !== action.clipId)
      return
    case 'trimEnd': {
      const c = track.clips.find((x) => x.id === action.clipId)
      if (!c) return
      const sourceDelta = sround((c.durationFrames - action.newDuration) * c.speed)
      c.trimEndFrame += sourceDelta
      setClipDuration(c, action.newDuration)
      return
    }
    case 'trimStart': {
      const c = track.clips.find((x) => x.id === action.clipId)
      if (!c) return
      c.startFrame = action.newStartFrame
      c.trimStartFrame = action.newTrimStart
      setClipDuration(c, action.newDuration)
      return
    }
    case 'split': {
      const c = track.clips.find((x) => x.id === action.clipId)
      if (!c) return
      const orig = current(c)
      // Right fragment keeps the original tail; the middle [regionStart, regionEnd) is dropped
      // because `left` now ends at regionStart and `right` begins at regionEnd.
      const right = cloneClip(orig)
      right.id = action.rightId
      right.startFrame = action.rightStartFrame
      right.trimStartFrame = action.rightTrimStart
      right.trimEndFrame = orig.trimEndFrame
      right.fadeInFrames = 0
      setClipDuration(right, action.rightDuration)
      // Left fragment: everything after `leftDuration` becomes tail trim.
      const tailSource = sround((orig.durationFrames - action.leftDuration) * orig.speed)
      c.trimEndFrame = orig.trimEndFrame + tailSource
      c.fadeOutFrames = 0
      setClipDuration(c, action.leftDuration)
      track.clips.push(right)
      return
    }
  }
}

/** Clear `[start, end)` on a track by removing / trimming / splitting overlapping clips. */
function clearRegionInTrack(track: Track, start: number, end: number): void {
  if (end <= start) return
  const actions = computeOverwrite(track.clips, start, end, newId)
  for (const action of actions) applyOverwriteAction(track, action)
  sortTrack(track)
}

/** Dry-run a set of shifts on a track: returns a blocking reason, or null if safe. */
function validateShifts(track: Track, label: string, shifts: ClipShift[]): string | null {
  if (shifts.length === 0) return null
  const shiftMap = new Map(shifts.map((s) => [s.clipId, s.newStartFrame]))
  const intervals: FrameRange[] = []
  for (const clip of track.clips) {
    const start = shiftMap.get(clip.id) ?? clip.startFrame
    if (start < 0) return `Sync-locked track "${label}" would move past the timeline start.`
    intervals.push({ start, end: start + clip.durationFrames })
  }
  intervals.sort((a, b) => a.start - b.start)
  for (let i = 1; i < intervals.length; i++) {
    if (intervals[i].start < intervals[i - 1].end) {
      return `Sync-locked track "${label}" doesn't have room to ripple.`
    }
  }
  return null
}

// MARK: - EditorController

export class EditorController {
  private timeline: Timeline
  private currentFrame = 0
  private selected = new Set<string>()
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private listeners = new Set<EditorListener>()
  private origin: CommandOrigin = 'user'

  // Transaction state — accumulates patches across nested mutations into one undo step.
  private txDepth = 0
  private txPatches: Patch[] = []
  private txInverse: Patch[] = []
  private txLabel = ''
  private txChanged = false

  constructor(initial?: Timeline) {
    this.timeline = initial ?? makeTimeline()
  }

  // MARK: Subscriptions / snapshot

  subscribe(listener: EditorListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(kind: EditorChangeKind): void {
    for (const l of this.listeners) l(kind)
  }

  getTimeline(): Timeline {
    return this.timeline
  }

  getCurrentFrame(): number {
    return this.currentFrame
  }

  getSelectedClipIds(): string[] {
    return Array.from(this.selected)
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  snapshot(): EditorSnapshot {
    return {
      timeline: this.timeline,
      currentFrame: this.currentFrame,
      selectedClipIds: Array.from(this.selected),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack[this.undoStack.length - 1]?.label ?? null,
      redoLabel: this.redoStack[this.redoStack.length - 1]?.label ?? null,
      undoOrigin: this.undoStack[this.undoStack.length - 1]?.origin ?? null,
      redoOrigin: this.redoStack[this.redoStack.length - 1]?.origin ?? null
    }
  }

  // MARK: Query getters

  getClip(id: string): Clip | null {
    const loc = locateClip(this.timeline, id)
    return loc ? this.timeline.tracks[loc.trackIndex].clips[loc.clipIndex] : null
  }

  getTrack(trackId: string): Track | null {
    return this.timeline.tracks.find((t) => t.id === trackId) ?? null
  }

  getTrackIndex(trackId: string): number {
    return trackIndexById(this.timeline, trackId)
  }

  totalFrames(): number {
    return totalFrames(this.timeline)
  }

  // MARK: Transactions / origin

  /** Run `fn` (which may issue several commands) and tag every undo entry it produces
   *  with `origin`. Used by the in-app agent / MCP server: `runAs('agent', …)`. */
  runAs<T>(origin: CommandOrigin, fn: () => T): T {
    const prev = this.origin
    this.origin = origin
    try {
      return fn()
    } finally {
      this.origin = prev
    }
  }

  /** Group several commands into a single undo step. */
  transact<T>(label: string, fn: () => T): T {
    return this.run(label, fn)
  }

  private run<T>(label: string, fn: () => T): T {
    const top = this.txDepth === 0
    this.txDepth += 1
    if (top) {
      this.txPatches = []
      this.txInverse = []
      this.txLabel = label
      this.txChanged = false
    }
    try {
      return fn()
    } finally {
      this.txDepth -= 1
      if (this.txDepth === 0 && this.txChanged && this.txPatches.length > 0) {
        this.undoStack.push({
          patches: this.txPatches,
          inverse: this.txInverse,
          label: this.txLabel,
          origin: this.origin
        })
        this.redoStack = []
        this.txPatches = []
        this.txInverse = []
        this.emit('edit')
      }
    }
  }

  private mutate(recipe: (tl: Timeline) => void): void {
    const [next, patches, inverse] = produceWithPatches(this.timeline, recipe)
    if (patches.length === 0) return
    this.timeline = next
    this.txPatches.push(...patches)
    // Inverse patches must be replayed in reverse order of forward steps.
    this.txInverse.unshift(...inverse)
    this.txChanged = true
  }

  // MARK: Undo / redo

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.timeline = applyPatches(this.timeline, entry.inverse)
    this.redoStack.push(entry)
    this.pruneSelection(false)
    this.emit('edit')
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.timeline = applyPatches(this.timeline, entry.patches)
    this.undoStack.push(entry)
    this.pruneSelection(false)
    this.emit('edit')
    return true
  }

  // MARK: Project lifecycle

  /** Replace the whole timeline (e.g. after open) and reset undo history. */
  load(timeline: Timeline): void {
    this.timeline = timeline
    this.undoStack = []
    this.redoStack = []
    this.currentFrame = 0
    this.selected.clear()
    this.emit('load')
  }

  reset(timeline?: Timeline): void {
    this.load(timeline ?? makeTimeline())
  }

  setResolution(width: number, height: number): void {
    this.run('Set Resolution', () =>
      this.mutate((tl) => {
        tl.width = width
        tl.height = height
        tl.settingsConfigured = true
      })
    )
  }

  setFps(fps: number): void {
    this.run('Set FPS', () =>
      this.mutate((tl) => {
        tl.fps = fps
        tl.settingsConfigured = true
      })
    )
  }

  // MARK: Tracks

  addTrack(type: ClipType, atIndex?: number): string {
    const id = newId()
    this.run('Add Track', () =>
      this.mutate((tl) => {
        const idx = partitionIndex(tl, type, atIndex ?? tl.tracks.length)
        tl.tracks.splice(idx, 0, makeTrack({ id, type }))
      })
    )
    return id
  }

  removeTrack(trackId: string): void {
    this.run('Remove Track', () =>
      this.mutate((tl) => {
        const i = trackIndexById(tl, trackId)
        if (i < 0) return
        tl.tracks.splice(i, 1)
      })
    )
    this.pruneSelection()
  }

  setTrackMuted(trackId: string, value?: boolean): void {
    this.setTrackFlag(trackId, 'muted', value, 'Mute Track')
  }

  setTrackHidden(trackId: string, value?: boolean): void {
    this.setTrackFlag(trackId, 'hidden', value, 'Hide Track')
  }

  setTrackSyncLocked(trackId: string, value?: boolean): void {
    this.setTrackFlag(trackId, 'syncLocked', value, 'Sync Lock Track')
  }

  private setTrackFlag(
    trackId: string,
    key: 'muted' | 'hidden' | 'syncLocked',
    value: boolean | undefined,
    label: string
  ): void {
    this.run(label, () =>
      this.mutate((tl) => {
        const i = trackIndexById(tl, trackId)
        if (i < 0) return
        tl.tracks[i][key] = value ?? !tl.tracks[i][key]
      })
    )
  }

  // MARK: Add / overwrite / ripple-insert clips

  /** Overwrite-add: clears the landing region `[start, start+duration)` first, then
   *  drops the new clip. Returns the new clip id, or null if the track was missing. */
  addClip(args: AddClipArgs): string | null {
    const id = args.id ?? newId()
    let placed = false
    this.run('Add Clip', () =>
      this.mutate((tl) => {
        const ti = trackIndexById(tl, args.trackId)
        if (ti < 0) return
        const track = tl.tracks[ti]
        const start = Math.max(0, args.startFrame)
        const dur = Math.max(0, args.durationFrames)
        clearRegionInTrack(track, start, start + dur)
        track.clips.push(
          makeClip({
            id,
            mediaRef: args.mediaRef,
            mediaType: args.mediaType ?? track.type,
            sourceClipType: args.sourceClipType,
            startFrame: start,
            durationFrames: dur,
            trimStartFrame: args.trimStartFrame,
            trimEndFrame: args.trimEndFrame,
            speed: args.speed,
            volume: args.volume
          })
        )
        sortTrack(track)
        placed = true
      })
    )
    return placed ? id : null
  }

  /** Explicit overwrite-add — identical semantics to `addClip` (kept as a named command). */
  overwriteClip(args: AddClipArgs): string | null {
    return this.addClip(args)
  }

  /** Clear a region on a track without inserting anything (the overwrite primitive). */
  clearRegion(trackId: string, start: number, end: number): void {
    this.run('Clear Region', () =>
      this.mutate((tl) => {
        const ti = trackIndexById(tl, trackId)
        if (ti < 0) return
        clearRegionInTrack(tl.tracks[ti], start, end)
      })
    )
  }

  /** Ripple-insert: push everything at/after `start` (on the target track and every
   *  sync-locked track) right by `duration`, then drop the new clip. */
  rippleInsertClip(args: AddClipArgs): string | null {
    const id = args.id ?? newId()
    let placed = false
    this.run('Ripple Insert', () =>
      this.mutate((tl) => {
        const ti = trackIndexById(tl, args.trackId)
        if (ti < 0) return
        const start = Math.max(0, args.startFrame)
        const dur = Math.max(0, args.durationFrames)
        for (let i = 0; i < tl.tracks.length; i++) {
          if (i === ti || tl.tracks[i].syncLocked) {
            applyShifts(tl, computeRipplePush(tl.tracks[i].clips, start, dur))
          }
        }
        const track = tl.tracks[ti]
        track.clips.push(
          makeClip({
            id,
            mediaRef: args.mediaRef,
            mediaType: args.mediaType ?? track.type,
            sourceClipType: args.sourceClipType,
            startFrame: start,
            durationFrames: dur,
            trimStartFrame: args.trimStartFrame,
            trimEndFrame: args.trimEndFrame,
            speed: args.speed,
            volume: args.volume
          })
        )
        sortTrack(track)
        placed = true
      })
    )
    return placed ? id : null
  }

  // MARK: Move

  moveClip(clipId: string, toTrackId: string, toFrame: number): void {
    this.moveClips([{ clipId, toTrackId, toFrame }])
  }

  /** Move clips with overwrite at their destinations. Incompatible track-type moves are
   *  skipped. Moved clips are pulled off their tracks first so clearing never hits them. */
  moveClips(moves: MoveSpec[]): void {
    if (moves.length === 0) return
    this.run(moves.length === 1 ? 'Move Clip' : 'Move Clips', () =>
      this.mutate((tl) => {
        const infos: { clip: Clip; toTrackId: string; toFrame: number }[] = []
        for (const m of moves) {
          const loc = locateClip(tl, m.clipId)
          const tiTo = trackIndexById(tl, m.toTrackId)
          if (!loc || tiTo < 0) continue
          if (!isCompatible(tl.tracks[tiTo].type, tl.tracks[loc.trackIndex].type)) continue
          infos.push({
            clip: cloneClip(current(tl.tracks[loc.trackIndex].clips[loc.clipIndex])),
            toTrackId: m.toTrackId,
            toFrame: Math.max(0, m.toFrame)
          })
        }
        if (infos.length === 0) return

        const movedIds = new Set(infos.map((i) => i.clip.id))
        for (const t of tl.tracks) t.clips = t.clips.filter((c) => !movedIds.has(c.id))

        for (const info of infos) {
          const ti = trackIndexById(tl, info.toTrackId)
          if (ti < 0) continue
          clearRegionInTrack(tl.tracks[ti], info.toFrame, info.toFrame + info.clip.durationFrames)
        }
        for (const info of infos) {
          const ti = trackIndexById(tl, info.toTrackId)
          if (ti < 0) continue
          const clip = cloneClip(info.clip)
          clip.startFrame = info.toFrame
          tl.tracks[ti].clips.push(clip)
        }
        for (const t of tl.tracks) sortTrack(t)
      })
    )
  }

  // MARK: Trim

  /** Trim a clip to new source-frame trims. Overwrite-style: resizes in place; the clip's
   *  start/duration absorb the change and neighbors are left untouched. */
  trimClip(clipId: string, trimStartFrame: number, trimEndFrame: number): void {
    this.run('Trim Clip', () =>
      this.mutate((tl) => {
        const loc = locateClip(tl, clipId)
        if (!loc) return
        const c = tl.tracks[loc.trackIndex].clips[loc.clipIndex]
        const speed = c.speed || 1
        const deltaStartTimeline = sround((trimStartFrame - c.trimStartFrame) / speed)
        const deltaEndTimeline = sround((trimEndFrame - c.trimEndFrame) / speed)
        const newDuration = c.durationFrames - deltaStartTimeline - deltaEndTimeline
        c.trimStartFrame = trimStartFrame
        c.trimEndFrame = trimEndFrame
        c.startFrame = Math.max(0, c.startFrame + deltaStartTimeline)
        setClipDuration(c, newDuration)
        sortTrack(tl.tracks[loc.trackIndex])
      })
    )
  }

  trimClipStart(clipId: string, newTrimStartFrame: number): void {
    const c = this.getClip(clipId)
    if (!c) return
    this.trimClip(clipId, Math.max(0, newTrimStartFrame), c.trimEndFrame)
  }

  trimClipEnd(clipId: string, newTrimEndFrame: number): void {
    const c = this.getClip(clipId)
    if (!c) return
    this.trimClip(clipId, c.trimStartFrame, Math.max(0, newTrimEndFrame))
  }

  trimStartToPlayhead(ids?: string[]): void {
    const targets = ids ?? this.getSelectedClipIds()
    this.run('Trim Clip', () => {
      for (const id of targets) {
        const c = this.getClip(id)
        if (!c || !(this.currentFrame > c.startFrame && this.currentFrame < clipEndFrame(c))) continue
        const sourceDelta = sround((this.currentFrame - c.startFrame) * c.speed)
        this.trimClip(id, c.trimStartFrame + sourceDelta, c.trimEndFrame)
      }
    })
  }

  trimEndToPlayhead(ids?: string[]): void {
    const targets = ids ?? this.getSelectedClipIds()
    this.run('Trim Clip', () => {
      for (const id of targets) {
        const c = this.getClip(id)
        if (!c || !(this.currentFrame > c.startFrame && this.currentFrame < clipEndFrame(c))) continue
        const sourceDelta = sround((clipEndFrame(c) - this.currentFrame) * c.speed)
        this.trimClip(id, c.trimStartFrame, c.trimEndFrame + sourceDelta)
      }
    })
  }

  // MARK: Split

  /** Split `clipId` at timeline frame `atFrame`. Returns the new right-half id, or null. */
  splitClip(clipId: string, atFrame: number): string | null {
    let rightId: string | null = null
    this.run('Split Clip', () =>
      this.mutate((tl) => {
        const loc = locateClip(tl, clipId)
        if (!loc) return
        const track = tl.tracks[loc.trackIndex]
        const clip = track.clips[loc.clipIndex]
        if (!(atFrame > clip.startFrame && atFrame < clipEndFrame(clip))) return

        const orig = current(clip)
        const splitOffset = atFrame - orig.startFrame
        const leftSource = sround(splitOffset * orig.speed)
        const rightSource = sround((orig.durationFrames - splitOffset) * orig.speed)

        const right = cloneClip(orig)
        right.id = newId()
        right.startFrame = atFrame
        right.trimStartFrame = orig.trimStartFrame + leftSource
        right.trimEndFrame = orig.trimEndFrame
        right.fadeInFrames = 0
        setClipDuration(right, orig.durationFrames - splitOffset)

        clip.trimEndFrame = orig.trimEndFrame + rightSource
        clip.fadeOutFrames = 0
        setClipDuration(clip, splitOffset)

        // Keep the volume envelope continuous across the cut.
        if (orig.volumeTrack && orig.volumeTrack.keyframes.length > 0) {
          const boundaryDb = sampleTrack(orig.volumeTrack, splitOffset, 0, lerpNumber)
          const leftKfs = orig.volumeTrack.keyframes.filter((k) => k.frame <= splitOffset).map((k) => ({ ...k }))
          if (leftKfs.length === 0 || leftKfs[leftKfs.length - 1].frame !== splitOffset) {
            leftKfs.push({ frame: splitOffset, value: boundaryDb, interpolationOut: 'smooth' })
          }
          clip.volumeTrack = { keyframes: leftKfs }
          const rightKfs = orig.volumeTrack.keyframes
            .filter((k) => k.frame >= splitOffset)
            .map((k) => ({ frame: k.frame - splitOffset, value: k.value, interpolationOut: k.interpolationOut }))
          if (rightKfs.length === 0 || rightKfs[0].frame !== 0) {
            rightKfs.unshift({ frame: 0, value: boundaryDb, interpolationOut: 'smooth' })
          }
          right.volumeTrack = { keyframes: rightKfs }
        }

        track.clips.push(right)
        sortTrack(track)
        rightId = right.id
      })
    )
    return rightId
  }

  splitAtPlayhead(ids?: string[]): string[] {
    const targets = ids ?? this.getSelectedClipIds()
    const created: string[] = []
    this.run('Split Clip', () => {
      for (const id of targets) {
        const r = this.splitClip(id, this.currentFrame)
        if (r) created.push(r)
      }
    })
    return created
  }

  // MARK: Remove / ripple-delete

  removeClip(id: string): void {
    this.removeClips([id])
  }

  removeClips(ids: string[] | Set<string>): void {
    const idSet = ids instanceof Set ? ids : new Set(ids)
    if (idSet.size === 0) return
    let count = 0
    for (const t of this.timeline.tracks) for (const c of t.clips) if (idSet.has(c.id)) count += 1
    this.run(count === 1 ? 'Remove Clip' : 'Remove Clips', () =>
      this.mutate((tl) => {
        for (const t of tl.tracks) t.clips = t.clips.filter((c) => !idSet.has(c.id))
      })
    )
    this.pruneSelection()
  }

  /** Ripple-delete: remove `ids` and close the gaps. Sync-locked tracks shift to stay
   *  aligned; refuses (no mutation) if a sync-locked follower can't absorb the shift. */
  rippleDelete(ids: string[] | Set<string>): RippleOutcome {
    const idSet = ids instanceof Set ? ids : new Set(ids)
    if (idSet.size === 0) return { ok: false, reason: 'Nothing selected', removedFrames: 0, shiftedClips: 0 }

    const tl = this.timeline
    const removedRanges: FrameRange[] = []
    for (const t of tl.tracks) {
      for (const c of t.clips) {
        if (idSet.has(c.id)) removedRanges.push({ start: c.startFrame, end: clipEndFrame(c) })
      }
    }
    if (removedRanges.length === 0) {
      return { ok: false, reason: 'No matching clips', removedFrames: 0, shiftedClips: 0 }
    }

    const shiftsByTrack = new Map<number, ClipShift[]>()
    for (let ti = 0; ti < tl.tracks.length; ti++) {
      const track = tl.tracks[ti]
      const hasOwn = track.clips.some((c) => idSet.has(c.id))
      if (hasOwn) {
        shiftsByTrack.set(ti, computeRippleShifts(track.clips, idSet))
      } else if (track.syncLocked) {
        const shifts = computeRippleShiftsForRanges(track.clips, removedRanges)
        const reason = validateShifts(track, `track ${ti + 1}`, shifts)
        if (reason) return { ok: false, reason, removedFrames: 0, shiftedClips: 0 }
        shiftsByTrack.set(ti, shifts)
      }
    }

    const removedFrames = mergeRanges(removedRanges).reduce((acc, r) => acc + frameRangeLength(r), 0)
    let shiftedClips = 0
    this.run('Ripple Delete', () =>
      this.mutate((draft) => {
        for (const t of draft.tracks) t.clips = t.clips.filter((c) => !idSet.has(c.id))
        for (const shifts of shiftsByTrack.values()) shiftedClips += applyShifts(draft, shifts)
        for (const t of draft.tracks) sortTrack(t)
      })
    )
    this.pruneSelection()
    return { ok: true, removedFrames, shiftedClips }
  }

  // MARK: Speed / properties

  setClipSpeed(clipId: string, newSpeed: number): void {
    if (newSpeed <= 0) return
    this.run('Change Speed', () =>
      this.mutate((tl) => {
        const loc = locateClip(tl, clipId)
        if (!loc) return
        const ti = loc.trackIndex
        const c = tl.tracks[ti].clips[loc.clipIndex]
        const sourceFrames = c.durationFrames * c.speed
        const newDuration = Math.max(1, sround(sourceFrames / newSpeed))
        const oldEnd = clipEndFrame(c)
        c.speed = newSpeed
        setClipDuration(c, newDuration)
        clampKeyframesToDuration(c)
        const rippleDelta = c.startFrame + newDuration - oldEnd
        if (rippleDelta !== 0) {
          const chain = contiguousClipIds(tl.tracks[ti], oldEnd, c.id)
          for (const cc of tl.tracks[ti].clips) if (chain.has(cc.id)) cc.startFrame += rippleDelta
        }
        sortTrack(tl.tracks[ti])
      })
    )
  }

  /** Edit whitelisted appearance fields (volume, opacity, fades, transform, crop, text). */
  setClipProperties(clipId: string, props: ClipPropertyEdit, label = 'Change Clip Property'): void {
    this.run(label, () =>
      this.mutate((tl) => {
        const loc = locateClip(tl, clipId)
        if (!loc) return
        const c = tl.tracks[loc.trackIndex].clips[loc.clipIndex]
        for (const key of EDITABLE_KEYS) {
          if (props[key] !== undefined) {
            // Whitelisted keys only; safe to write through.
            ;(c as unknown as Record<string, unknown>)[key] = props[key] as unknown
          }
        }
        clampFadesToDuration(c)
      })
    )
  }

  /** Merge a partial color grade onto a clip (so one slider doesn't reset the others) as one undo step. */
  setClipColor(clipId: string, patch: Partial<ColorAdjustments>, label = 'Change Color'): void {
    const c = this.getClip(clipId)
    if (!c) return
    this.setClipProperties(clipId, { color: mergeColor(c.color ?? IDENTITY_COLOR, patch) }, label)
  }

  // MARK: Playhead / selection (not undoable)

  seek(frame: number): void {
    const f = Math.max(0, Math.round(frame))
    if (f === this.currentFrame) return
    this.currentFrame = f
    this.emit('view')
  }

  select(ids: string[]): void {
    this.selected = new Set(ids)
    this.emit('view')
  }

  selectOnly(id: string): void {
    this.select([id])
  }

  addToSelection(id: string): void {
    if (this.selected.has(id)) return
    this.selected.add(id)
    this.emit('view')
  }

  toggleSelection(id: string): void {
    if (this.selected.has(id)) this.selected.delete(id)
    else this.selected.add(id)
    this.emit('view')
  }

  clearSelection(): void {
    if (this.selected.size === 0) return
    this.selected.clear()
    this.emit('view')
  }

  private pruneSelection(emitIfChanged = true): void {
    const ids = new Set<string>()
    for (const t of this.timeline.tracks) for (const c of t.clips) ids.add(c.id)
    let changed = false
    for (const id of [...this.selected]) {
      if (!ids.has(id)) {
        this.selected.delete(id)
        changed = true
      }
    }
    if (changed && emitIfChanged) this.emit('view')
  }

  // MARK: Snapping (wires the snapEngine for the drag UI)

  /** Compute a snapped target for a clip being dragged. `position` is the proposed start
   *  frame; the result's snapped start is `frame - probeOffset`. The caller threads a
   *  persistent `SnapState` across drag events for sticky behavior. */
  snapMoveFrame(opts: {
    position: number
    durationFrames: number
    pixelsPerFrame: number
    state: SnapState
    excludeClipIds?: Set<string>
    includePlayhead?: boolean
  }): SnapResult | null {
    const targets = collectTargets({
      tracks: this.timeline.tracks,
      playheadFrame: this.currentFrame,
      excludeClipIds: opts.excludeClipIds,
      includePlayhead: opts.includePlayhead ?? true
    })
    return findSnap({
      position: opts.position,
      probeOffsets: [0, opts.durationFrames],
      targets,
      state: opts.state,
      baseThreshold: Snap.thresholdPixels,
      pixelsPerFrame: opts.pixelsPerFrame
    })
  }
}
