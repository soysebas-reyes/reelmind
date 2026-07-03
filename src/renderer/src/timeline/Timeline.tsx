// SPDX-License-Identifier: GPL-3.0-or-later
// The canvas timeline: ruler, playhead, tracks, clips, drag-from-bin, move (with snapping),
// trim handles, split, and ripple-delete. All edits go through the EditorController, so the
// in-app agent and MCP server (later phases) drive the exact same commands.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Clip,
  type ClipType,
  type MediaManifest,
  type SnapState,
  type Track,
  type TrackRole,
  clipEndFrame,
  isCompatible,
  makeSnapState,
  sround
} from '@core'
import { getController, timelineTotalFrames, useEditorStore } from '../store'
import ContextMenu, { type MenuEntry, type MenuItem } from '../ui/ContextMenu'
import {
  type ClipBox,
  type TimelineLayout,
  TRIM_HANDLE_PX,
  clipBox,
  frameForX,
  makeLayout,
  rulerStepFrames,
  trackIndexForY,
  trackTop,
  xForFrame
} from './geometry'

// Apple system palette (dark) so the canvas matches the CSS token layer.
const TYPE_COLORS: Record<ClipType, string> = {
  video: '#0a84ff',  // system blue
  audio: '#30d158',  // system green
  image: '#bf5af2',  // system purple
  text: '#ff9f0a',   // system orange
  lottie: '#ff375f'  // system pink
}
const ACCENT = '#0a84ff'
const TRACK_LABEL_PREFIX: Record<ClipType, string> = { video: 'V', audio: 'A', image: 'I', text: 'T', lottie: 'L' }

type TrackFlag = 'muted' | 'hidden' | 'syncLocked'
type ChipKind = 'flag' | 'delete' | 'role' | 'audio'

interface ChipRect {
  kind: ChipKind
  flag?: TrackFlag
  label: string
  box: ClipBox
}

/** Does this video track currently contribute audio? True when it isn't muted and at least one clip
 *  is audible (volume > 0) AND its source asset actually has an audio stream. Drives the 🔊/🔇 badge so
 *  it's obvious which video tracks still carry sound (e.g. after sync mutes them and moves audio out). */
function trackHasActiveAudio(track: Track, manifest: MediaManifest): boolean {
  if (track.muted) return false
  return track.clips.some(
    (c) => c.volume > 0 && (manifest.entries.find((e) => e.id === c.mediaRef)?.hasAudio ?? false)
  )
}

const ROLE_COLORS: Record<TrackRole, string> = {
  frontal: '#0a84ff',
  lateral: '#ff9f0a',
  broll: '#ff375f'
}

function roleInitial(role: TrackRole | undefined): string {
  return role === 'frontal' ? 'F' : role === 'lateral' ? 'L' : role === 'broll' ? 'B' : '·'
}

/** Header controls for a track: M/H/L flag chips + a ✕ delete chip (bottom row), and — for video
 *  tracks — a multicam role chip (F/L/B) plus a read-only audio badge (🔊/🔇) on the label row.
 *  Sized to fit within HEADER_WIDTH (108). `hasAudio` is only meaningful for video tracks. */
function headerChips(trackIndex: number, l: TimelineLayout, track: Track, hasAudio = false): ChipRect[] {
  const top = trackTop(trackIndex, l)
  const y = top + l.trackHeight - 24
  const w = 18
  const h = 17
  const gap = 4
  const x0 = 12
  const flags: { flag: TrackFlag; label: string }[] = [
    { flag: 'muted', label: 'M' },
    { flag: 'hidden', label: 'H' },
    { flag: 'syncLocked', label: 'L' }
  ]
  const chips: ChipRect[] = flags.map((f, i) => ({
    kind: 'flag' as const,
    flag: f.flag,
    label: f.label,
    box: { x: x0 + i * (w + gap), y, w, h }
  }))
  // Delete chip after the flag chips.
  chips.push({ kind: 'delete', label: '✕', box: { x: x0 + flags.length * (w + gap), y, w, h } })
  // Role chip + audio badge on the label row, right of the "V1" label (video tracks only).
  if (track.type === 'video') {
    chips.push({ kind: 'role', label: roleInitial(track.role), box: { x: 46, y: top + 6, w: 22, h: 17 } })
    chips.push({ kind: 'audio', label: hasAudio ? '🔊' : '🔇', box: { x: 72, y: top + 6, w: 22, h: 17 } })
  }
  return chips
}

/** Track label like V1 / A1, numbered within its own type. */
function trackLabelFor(types: ClipType[], index: number): string {
  const type = types[index]
  let n = 0
  for (let i = 0; i <= index; i++) if (types[i] === type) n += 1
  return `${TRACK_LABEL_PREFIX[type]}${n}`
}

type Interaction =
  | { kind: 'seek' }
  | {
      kind: 'move'
      clipId: string
      fromTrackIndex: number
      grabFrames: number
      durationFrames: number
      ghostStart: number
      ghostTrackIndex: number
      snapX: number | null
    }
  | {
      kind: 'trimStart' | 'trimEnd'
      clipId: string
      trackIndex: number
      ghostStart: number
      ghostDuration: number
      snapX: number | null
    }

export default function Timeline(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const currentFrame = useEditorStore((s) => s.currentFrame)
  const selectedClipIds = useEditorStore((s) => s.selectedClipIds)
  const thumbnails = useEditorStore((s) => s.thumbnails)
  const manifest = useEditorStore((s) => s.manifest)
  const anglePlan = useEditorStore((s) => s.anglePlan)
  const isPlaying = useEditorStore((s) => s.isPlaying)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const interactionRef = useRef<Interaction | null>(null)
  const snapStateRef = useRef<SnapState>(makeSnapState())
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const drawRef = useRef<() => void>(() => {})

  const [pixelsPerFrame, setPixelsPerFrame] = useState(4)
  const [scrollX, setScrollX] = useState(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [notice, setNotice] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)

  const layout = useMemo<TimelineLayout>(() => makeLayout(pixelsPerFrame), [pixelsPerFrame])
  const selected = useMemo(() => new Set(selectedClipIds), [selectedClipIds])
  const totalFrames = timelineTotalFrames(timeline)
  const maxScrollX = Math.max(0, layout.headerWidth + (totalFrames + 240 / pixelsPerFrame) * pixelsPerFrame - size.width)

  const flashNotice = useCallback((msg: string) => {
    setNotice(msg)
    window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2600)
  }, [])

  // Resolve (and cache) a thumbnail image element for a clip's source asset.
  const imageFor = useCallback(
    (assetId: string): HTMLImageElement | null => {
      const data = thumbnails[assetId]
      if (!data) return null
      const cache = imageCacheRef.current
      let img = cache.get(assetId)
      if (!img) {
        img = new Image()
        img.onload = () => drawRef.current()
        img.src = data
        cache.set(assetId, img)
      }
      return img.complete && img.naturalWidth > 0 ? img : null
    },
    [thumbnails]
  )

  function draw(): void {
    const cvs = canvasRef.current
    const ctx = cvs?.getContext('2d')
    if (!cvs || !ctx) return
    const { width, height } = size
    if (width === 0 || height === 0) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const tracks = timeline.tracks
    const types = tracks.map((t) => t.type)
    const l = layout

    // Track lane backgrounds (alternating).
    for (let i = 0; i < tracks.length; i++) {
      const top = trackTop(i, l)
      ctx.fillStyle = i % 2 === 0 ? '#000000' : '#08080a'
      ctx.fillRect(l.headerWidth, top, width - l.headerWidth, l.trackHeight)
    }

    // Ruler.
    ctx.fillStyle = '#000000'
    ctx.fillRect(l.headerWidth, 0, width - l.headerWidth, l.rulerHeight)
    const step = rulerStepFrames(l, timeline.fps)
    ctx.strokeStyle = '#2c2c2e'
    ctx.fillStyle = '#8e8e93'
    ctx.font = '10px -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
    ctx.textBaseline = 'middle'
    const firstFrame = Math.max(0, Math.floor(scrollX / l.pixelsPerFrame / step) * step)
    for (let f = firstFrame; ; f += step) {
      const x = xForFrame(f, l, scrollX)
      if (x > width) break
      if (x < l.headerWidth) continue
      ctx.beginPath()
      ctx.moveTo(x, l.rulerHeight - 8)
      ctx.lineTo(x, height)
      ctx.globalAlpha = 0.25
      ctx.stroke()
      ctx.globalAlpha = 1
      const secs = f / timeline.fps
      const mm = Math.floor(secs / 60)
      const ss = Math.floor(secs % 60)
      ctx.fillText(`${mm}:${String(ss).padStart(2, '0')}`, x + 4, l.rulerHeight / 2)
    }

    // Clips.
    for (let ti = 0; ti < tracks.length; ti++) {
      for (const clip of tracks[ti].clips) {
        const box = clipBox(clip, ti, l, scrollX)
        if (box.x + box.w < l.headerWidth || box.x > width) continue
        drawClip(ctx, clip, box, selected.has(clip.id), tracks[ti].hidden || tracks[ti].muted)
      }
    }

    // Ghost (active drag).
    const it = interactionRef.current
    if (it && it.kind === 'move') {
      const box = clipBoxAt(it.ghostStart, it.durationFrames, it.ghostTrackIndex, l, scrollX)
      ctx.save()
      ctx.globalAlpha = 0.55
      ctx.fillStyle = ACCENT
      roundRect(ctx, box.x, box.y, box.w, box.h, 6)
      ctx.fill()
      ctx.restore()
      if (it.snapX !== null) drawSnap(ctx, it.snapX, l, height)
    } else if (it && (it.kind === 'trimStart' || it.kind === 'trimEnd')) {
      const box = clipBoxAt(it.ghostStart, it.ghostDuration, it.trackIndex, l, scrollX)
      ctx.save()
      ctx.strokeStyle = ACCENT
      ctx.lineWidth = 2
      roundRect(ctx, box.x, box.y, box.w, box.h, 6)
      ctx.stroke()
      ctx.restore()
      if (it.snapX !== null) drawSnap(ctx, it.snapX, l, height)
    }

    // Header column.
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, l.headerWidth, height)
    ctx.strokeStyle = '#2c2c2e'
    ctx.beginPath()
    ctx.moveTo(l.headerWidth + 0.5, 0)
    ctx.lineTo(l.headerWidth + 0.5, height)
    ctx.stroke()
    for (let ti = 0; ti < tracks.length; ti++) {
      const top = trackTop(ti, l)
      ctx.fillStyle = TYPE_COLORS[tracks[ti].type]
      ctx.fillRect(0, top, 3, l.trackHeight)
      ctx.fillStyle = '#ffffff'
      ctx.font = '600 12px -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(trackLabelFor(types, ti), 12, top + 20)
      const trackAudio = tracks[ti].type === 'video' && trackHasActiveAudio(tracks[ti], manifest)
      for (const chip of headerChips(ti, l, tracks[ti], trackAudio)) {
        const cx = chip.box.x + chip.box.w / 2
        const cy = chip.box.y + chip.box.h / 2 + 1
        if (chip.kind === 'audio') {
          ctx.fillStyle = '#1c1c1e'
          roundRect(ctx, chip.box.x, chip.box.y, chip.box.w, chip.box.h, 4)
          ctx.fill()
          ctx.globalAlpha = trackAudio ? 1 : 0.5
          ctx.font = '11px Segoe UI, system-ui, sans-serif'
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          ctx.fillText(chip.label, cx, cy)
          ctx.globalAlpha = 1
          ctx.textAlign = 'left'
          continue
        }
        if (chip.kind === 'role') {
          const col = tracks[ti].role ? ROLE_COLORS[tracks[ti].role as TrackRole] : '#3f3f46'
          ctx.fillStyle = '#1c1c1e'
          roundRect(ctx, chip.box.x, chip.box.y, chip.box.w, chip.box.h, 4)
          ctx.fill()
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          roundRect(ctx, chip.box.x + 0.5, chip.box.y + 0.5, chip.box.w - 1, chip.box.h - 1, 4)
          ctx.stroke()
          ctx.fillStyle = col
          ctx.font = '700 10px Segoe UI, system-ui, sans-serif'
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          ctx.fillText(chip.label, cx, cy)
          ctx.textAlign = 'left'
          continue
        }
        if (chip.kind === 'delete') {
          ctx.fillStyle = '#1c1c1e'
          roundRect(ctx, chip.box.x, chip.box.y, chip.box.w, chip.box.h, 4)
          ctx.fill()
          ctx.fillStyle = '#f87171'
          ctx.font = '600 10px Segoe UI, system-ui, sans-serif'
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'center'
          ctx.fillText(chip.label, cx, cy)
          ctx.textAlign = 'left'
          continue
        }
        const on = tracks[ti][chip.flag as TrackFlag] as boolean
        ctx.fillStyle = on ? (chip.flag === 'syncLocked' ? '#1e293b' : '#7f1d1d') : '#18181b'
        roundRect(ctx, chip.box.x, chip.box.y, chip.box.w, chip.box.h, 4)
        ctx.fill()
        ctx.fillStyle = on ? (chip.flag === 'syncLocked' ? '#38bdf8' : '#f87171') : '#71717a'
        ctx.font = '600 10px Segoe UI, system-ui, sans-serif'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        ctx.fillText(chip.label, cx, cy)
        ctx.textAlign = 'left'
      }
    }

    // Angle-cut plan marks (preview): a dashed guide + flag at each proposed angle change, colored
    // by the angle that starts there. Cleared once the plan is applied or cancelled.
    if (anglePlan) {
      for (let i = 1; i < anglePlan.segments.length; i++) {
        const seg = anglePlan.segments[i]
        const mx = xForFrame(seg.startFrame, l, scrollX)
        if (mx < l.headerWidth || mx > width) continue
        const col = ROLE_COLORS[seg.role]
        ctx.save()
        ctx.strokeStyle = col
        ctx.lineWidth = 1
        ctx.setLineDash([4, 3])
        ctx.beginPath()
        ctx.moveTo(mx, l.rulerHeight)
        ctx.lineTo(mx, height)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.moveTo(mx, l.rulerHeight)
        ctx.lineTo(mx + 7, l.rulerHeight)
        ctx.lineTo(mx, l.rulerHeight + 7)
        ctx.closePath()
        ctx.fill()
        ctx.restore()
      }
    }

    // Playhead.
    const px = xForFrame(currentFrame, l, scrollX)
    if (px >= l.headerWidth && px <= width) {
      ctx.strokeStyle = '#ff5c7a'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(px, 0)
      ctx.lineTo(px, height)
      ctx.stroke()
      ctx.fillStyle = '#ff5c7a'
      ctx.beginPath()
      ctx.moveTo(px - 5, 0)
      ctx.lineTo(px + 5, 0)
      ctx.lineTo(px, 8)
      ctx.closePath()
      ctx.fill()
    }
  }

  function drawClip(ctx: CanvasRenderingContext2D, clip: Clip, box: ClipBox, isSelected: boolean, dim: boolean): void {
    const color = TYPE_COLORS[clip.mediaType] ?? TYPE_COLORS.video
    ctx.save()
    if (dim) ctx.globalAlpha = 0.5
    roundRect(ctx, box.x, box.y, box.w, box.h, 6)
    ctx.fillStyle = isSelected ? hexA(color, 0.42) : hexA(color, 0.24)
    ctx.fill()
    ctx.clip()

    const img = clip.mediaType !== 'audio' && clip.mediaType !== 'text' ? imageFor(clip.mediaRef) : null
    if (img && box.w > 20) {
      ctx.globalAlpha = (dim ? 0.5 : 1) * 0.55
      const ih = box.h
      const iw = ih * (img.naturalWidth / img.naturalHeight)
      ctx.drawImage(img, box.x, box.y, Math.min(iw, box.w), ih)
      ctx.globalAlpha = dim ? 0.5 : 1
    }
    if (clip.mediaType === 'audio') {
      ctx.strokeStyle = hexA(color, 0.8)
      ctx.lineWidth = 1
      const midY = box.y + box.h / 2
      ctx.beginPath()
      for (let x = box.x + 4; x < box.x + box.w - 2; x += 4) {
        const amp = (box.h / 2 - 8) * (0.35 + 0.65 * Math.abs(Math.sin(x * 0.4)))
        ctx.moveTo(x, midY - amp)
        ctx.lineTo(x, midY + amp)
      }
      ctx.stroke()
    }

    // Top accent.
    ctx.fillStyle = color
    ctx.fillRect(box.x, box.y, box.w, 3)

    ctx.restore()

    // Border.
    roundRect(ctx, box.x, box.y, box.w, box.h, 6)
    ctx.strokeStyle = isSelected ? ACCENT : hexA(color, 0.7)
    ctx.lineWidth = isSelected ? 2 : 1
    ctx.stroke()

    // Name.
    if (box.w > 28) {
      const name = nameFor(clip)
      ctx.save()
      roundRect(ctx, box.x, box.y, box.w, box.h, 6)
      ctx.clip()
      ctx.fillStyle = '#f2f2f8'
      ctx.font = '11px Segoe UI, system-ui, sans-serif'
      ctx.textBaseline = 'alphabetic'
      ctx.fillText(name, box.x + 7, box.y + box.h - 8, box.w - 12)
      ctx.restore()
    }

    // Trim handles when selected.
    if (isSelected && box.w > 16) {
      ctx.fillStyle = ACCENT
      ctx.fillRect(box.x, box.y, 3, box.h)
      ctx.fillRect(box.x + box.w - 3, box.y, 3, box.h)
    }
  }

  drawRef.current = draw

  // Size tracking.
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setSize({ width: Math.floor(r.width), height: Math.floor(r.height) })
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Backing-store sizing + redraw whenever inputs change.
  useEffect(() => {
    const cvs = canvasRef.current
    if (!cvs || size.width === 0) return
    const dpr = window.devicePixelRatio || 1
    cvs.width = Math.floor(size.width * dpr)
    cvs.height = Math.floor(size.height * dpr)
    cvs.style.width = `${size.width}px`
    cvs.style.height = `${size.height}px`
    draw()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, timeline, currentFrame, selectedClipIds, pixelsPerFrame, scrollX, thumbnails, manifest, anglePlan])

  // Keep scroll within bounds when content shrinks.
  useEffect(() => {
    if (scrollX > maxScrollX) setScrollX(maxScrollX)
  }, [scrollX, maxScrollX])

  // Auto-follow the playhead while playing (Premiere-style PAGE jump): when the playhead crosses the
  // right edge (or sits left of the visible window after a backward seek), jump the view a "page" so it
  // reappears near the left. Page-jumping (vs. continuous centering) avoids jitter from the ~10 Hz
  // store updates the playback clock pushes. Gated on `isPlaying` so manual scroll/zoom is untouched.
  useEffect(() => {
    if (!isPlaying || size.width === 0) return
    const px = xForFrame(currentFrame, layout, scrollX)
    const rightEdge = size.width - (size.width - layout.headerWidth) * 0.1
    if (px > rightEdge || px < layout.headerWidth) {
      const lead = (size.width - layout.headerWidth) * 0.1 // land the playhead ~10% from the left
      const next = Math.max(0, Math.min(currentFrame * layout.pixelsPerFrame - lead, maxScrollX))
      if (next !== scrollX) setScrollX(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, isPlaying, pixelsPerFrame, size.width, maxScrollX])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return
      }
      const c = getController()
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) c.redo()
        else c.undo()
      } else if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        c.redo()
      } else if (mod && (e.key === 'c' || e.key === 'C')) {
        if (c.getSelectedClipIds().length > 0) {
          e.preventDefault()
          useEditorStore.getState().copySelection()
        }
      } else if (mod && (e.key === 'x' || e.key === 'X')) {
        if (c.getSelectedClipIds().length > 0) {
          e.preventDefault()
          useEditorStore.getState().cutSelection()
        }
      } else if (mod && (e.key === 'v' || e.key === 'V')) {
        if (useEditorStore.getState().hasClipboard) {
          e.preventDefault()
          useEditorStore.getState().pasteAtFrame()
        }
      } else if (mod && (e.key === 'd' || e.key === 'D')) {
        if (c.getSelectedClipIds().length > 0) {
          e.preventDefault()
          useEditorStore.getState().duplicateSelection()
        }
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (c.getSelectedClipIds().length > 0) {
          e.preventDefault()
          c.removeClips(c.getSelectedClipIds())
        }
      } else if (e.key === 's' || e.key === 'S') {
        if (c.getSelectedClipIds().length > 0) {
          e.preventDefault()
          c.splitAtPlayhead()
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        c.seek(c.getCurrentFrame() - (e.shiftKey ? 10 : 1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        c.seek(c.getCurrentFrame() + (e.shiftKey ? 10 : 1))
      } else if (e.key === ' ' && !mod) {
        e.preventDefault()
        // A focused toolbar button would also activate on Space (click fires on keyup) — release it.
        if (t && t.tagName === 'BUTTON') t.blur()
        useEditorStore.getState().togglePlayback()
      } else if (e.key === 'Home') {
        e.preventDefault()
        c.seek(0)
      } else if (e.key === 'End') {
        e.preventDefault()
        c.seek(c.totalFrames())
      } else if (e.key === '[') {
        e.preventDefault()
        c.trimStartToPlayhead()
      } else if (e.key === ']') {
        e.preventDefault()
        c.trimEndToPlayhead()
      } else if ((e.key === '+' || e.key === '=') && !mod) {
        e.preventDefault()
        setPixelsPerFrame((z) => clamp(z * 1.25, 0.5, 40))
      } else if (e.key === '-' && !mod) {
        e.preventDefault()
        setPixelsPerFrame((z) => clamp(z * 0.8, 0.5, 40))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --- Pointer helpers ---

  function localPoint(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function hitClip(x: number, y: number): { clip: Clip; trackIndex: number; box: ClipBox } | { trackIndex: number } | null {
    const ti = trackIndexForY(y, layout, timeline.tracks.length)
    if (ti < 0 || ti >= timeline.tracks.length) return null
    for (const clip of timeline.tracks[ti].clips) {
      const box = clipBox(clip, ti, layout, scrollX)
      if (x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h) {
        return { clip, trackIndex: ti, box }
      }
    }
    return { trackIndex: ti }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>): void {
    // Only the primary button starts interactions — right-click belongs to the context menu
    // (without this, right-click used to start drags/seeks and capture the pointer).
    if (e.button !== 0) return
    const { x, y } = localPoint(e)
    const c = getController()

    // Header chips.
    if (x < layout.headerWidth) {
      const ti = trackIndexForY(y, layout, timeline.tracks.length)
      if (ti >= 0 && ti < timeline.tracks.length) {
        const track = timeline.tracks[ti]
        for (const chip of headerChips(ti, layout, track)) {
          if (x >= chip.box.x && x <= chip.box.x + chip.box.w && y >= chip.box.y && y <= chip.box.y + chip.box.h) {
            if (chip.kind === 'audio') return // read-only badge
            if (chip.kind === 'role') c.cycleTrackRole(track.id)
            else if (chip.kind === 'delete') {
              if (
                track.clips.length > 0 &&
                !window.confirm(`Esta pista tiene ${track.clips.length} clip(s). ¿Eliminar la pista y todos sus clips?`)
              )
                return
              c.removeTrack(track.id)
            } else if (chip.flag === 'muted') c.setTrackMuted(track.id)
            else if (chip.flag === 'hidden') c.setTrackHidden(track.id)
            else c.setTrackSyncLocked(track.id)
            return
          }
        }
        // Clicking the track NAME (no chip hit) selects the WHOLE track — every clip as one unit, so a
        // multicam track cut into many pieces can drive angle-cuts as a whole. Shift adds a second track.
        if (track.clips.length > 0) {
          c.selectTrackClips(track.id, e.shiftKey)
          flashNotice(`Pista seleccionada (${track.clips.length} clip${track.clips.length === 1 ? '' : 's'})`)
        }
      }
      return
    }

    // Ruler → scrub.
    if (y < layout.rulerHeight) {
      interactionRef.current = { kind: 'seek' }
      c.seek(frameForX(x, layout, scrollX))
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
      return
    }

    const hit = hitClip(x, y)
    if (hit && 'clip' in hit) {
      const { clip, trackIndex, box } = hit
      if (e.shiftKey) c.toggleSelection(clip.id)
      else if (!selected.has(clip.id)) c.selectOnly(clip.id)
      ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
      snapStateRef.current = makeSnapState()

      if (x <= box.x + TRIM_HANDLE_PX) {
        interactionRef.current = {
          kind: 'trimStart',
          clipId: clip.id,
          trackIndex,
          ghostStart: clip.startFrame,
          ghostDuration: clip.durationFrames,
          snapX: null
        }
      } else if (x >= box.x + box.w - TRIM_HANDLE_PX) {
        interactionRef.current = {
          kind: 'trimEnd',
          clipId: clip.id,
          trackIndex,
          ghostStart: clip.startFrame,
          ghostDuration: clip.durationFrames,
          snapX: null
        }
      } else {
        interactionRef.current = {
          kind: 'move',
          clipId: clip.id,
          fromTrackIndex: trackIndex,
          grabFrames: frameForX(x, layout, scrollX) - clip.startFrame,
          durationFrames: clip.durationFrames,
          ghostStart: clip.startFrame,
          ghostTrackIndex: trackIndex,
          snapX: null
        }
      }
      return
    }

    // Empty track area → deselect + scrub.
    c.clearSelection()
    interactionRef.current = { kind: 'seek' }
    c.seek(frameForX(x, layout, scrollX))
    ;(e.target as HTMLCanvasElement).setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>): void {
    const it = interactionRef.current
    if (!it) return
    const { x, y } = localPoint(e)
    const c = getController()
    const frame = frameForX(Math.max(layout.headerWidth, x), layout, scrollX)

    if (it.kind === 'seek') {
      c.seek(frame)
      return
    }

    if (it.kind === 'move') {
      const proposed = Math.max(0, frame - it.grabFrames)
      let targetIndex = trackIndexForY(y, layout, timeline.tracks.length)
      if (targetIndex < 0 || targetIndex >= timeline.tracks.length) targetIndex = it.fromTrackIndex
      const dstType = timeline.tracks[targetIndex].type
      const srcType = timeline.tracks[it.fromTrackIndex].type
      if (!isCompatible(dstType, srcType)) targetIndex = it.fromTrackIndex

      const snap = c.snapMoveFrame({
        position: proposed,
        durationFrames: it.durationFrames,
        pixelsPerFrame: layout.pixelsPerFrame,
        state: snapStateRef.current,
        excludeClipIds: new Set([it.clipId]),
        includePlayhead: true
      })
      const ghostStart = snap ? Math.max(0, snap.frame - snap.probeOffset) : proposed
      it.ghostStart = ghostStart
      it.ghostTrackIndex = targetIndex
      it.snapX = snap ? xForFrame(snap.frame, layout, scrollX) : null
      drawRef.current()
      return
    }

    // Trim.
    const clip = c.getClip(it.clipId)
    if (!clip) return
    const leftRoom = Math.floor(clip.trimStartFrame / clip.speed)
    const rightRoom = Math.floor(clip.trimEndFrame / clip.speed)
    const snap = c.snapMoveFrame({
      position: frame,
      durationFrames: 0,
      pixelsPerFrame: layout.pixelsPerFrame,
      state: snapStateRef.current,
      excludeClipIds: new Set([it.clipId]),
      includePlayhead: true
    })
    const edge = snap ? snap.frame : frame
    if (it.kind === 'trimStart') {
      const minStart = Math.max(0, clip.startFrame - leftRoom)
      const maxStart = clipEndFrame(clip) - 1
      const ghostStart = Math.min(maxStart, Math.max(minStart, edge))
      it.ghostStart = ghostStart
      it.ghostDuration = clipEndFrame(clip) - ghostStart
    } else {
      const minEnd = clip.startFrame + 1
      const maxEnd = clipEndFrame(clip) + rightRoom
      const ghostEnd = Math.min(maxEnd, Math.max(minEnd, edge))
      it.ghostStart = clip.startFrame
      it.ghostDuration = ghostEnd - clip.startFrame
    }
    it.snapX = snap ? xForFrame(snap.frame, layout, scrollX) : null
    drawRef.current()
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>): void {
    const it = interactionRef.current
    interactionRef.current = null
    snapStateRef.current = makeSnapState()
    if (!it) return
    const c = getController()
    try {
      ;(e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }

    if (it.kind === 'move') {
      const toTrackId = timeline.tracks[it.ghostTrackIndex]?.id
      if (toTrackId) c.moveClip(it.clipId, toTrackId, it.ghostStart)
    } else if (it.kind === 'trimStart') {
      const clip = c.getClip(it.clipId)
      if (clip) {
        const deltaTimeline = it.ghostStart - clip.startFrame
        c.trimClipStart(it.clipId, Math.max(0, clip.trimStartFrame + sround(deltaTimeline * clip.speed)))
      }
    } else if (it.kind === 'trimEnd') {
      const clip = c.getClip(it.clipId)
      if (clip) {
        const proposedEnd = clip.startFrame + it.ghostDuration
        const deltaTimeline = clipEndFrame(clip) - proposedEnd
        c.trimClipEnd(it.clipId, Math.max(0, clip.trimEndFrame + sround(deltaTimeline * clip.speed)))
      }
    }
    drawRef.current()
  }

  // --- Double-click → clip properties inspector ---

  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>): void {
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const hit = hitClip(e.clientX - r.left, e.clientY - r.top)
    if (hit && 'clip' in hit) {
      const clip = hit.clip as Clip
      getController().selectOnly(clip.id)
      useEditorStore.getState().setRightTab('props')
    }
  }

  // --- Right-click context menu ---

  function onContextMenu(e: React.MouseEvent<HTMLCanvasElement>): void {
    e.preventDefault()
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const c = getController()
    const store = useEditorStore.getState()
    const frame = Math.max(0, frameForX(Math.max(layout.headerWidth, x), layout, scrollX))

    // Track header → track menu.
    if (x < layout.headerWidth) {
      const ti = trackIndexForY(y, layout, timeline.tracks.length)
      if (ti < 0 || ti >= timeline.tracks.length) return
      const track = timeline.tracks[ti]
      const roleName: Record<string, string> = { frontal: 'Frontal', lateral: 'Lateral', broll: 'B-roll' }
      const roleEntry = (role: TrackRole | undefined, label: string): MenuEntry => ({
        label,
        checked: track.role === role,
        onClick: () => c.setTrackRole(track.id, role)
      })
      const items: MenuItem[] = [
        { label: 'Silenciar', checked: track.muted, onClick: () => c.setTrackMuted(track.id) },
        { label: 'Ocultar', checked: track.hidden, onClick: () => c.setTrackHidden(track.id) },
        { label: 'Bloquear sincronía', checked: track.syncLocked, onClick: () => c.setTrackSyncLocked(track.id) },
        'separator',
        {
          label: `Rol: ${track.role ? roleName[track.role] : 'Ninguno'}`,
          submenu: [
            roleEntry('frontal', 'Frontal'),
            roleEntry('lateral', 'Lateral'),
            roleEntry('broll', 'B-roll'),
            roleEntry(undefined, 'Ninguno')
          ]
        },
        'separator',
        {
          label: 'Seleccionar clips de la pista',
          disabled: track.clips.length === 0,
          onClick: () => c.selectTrackClips(track.id)
        },
        'separator',
        {
          label: 'Eliminar pista',
          danger: true,
          onClick: () => {
            if (
              track.clips.length > 0 &&
              !window.confirm(`Esta pista tiene ${track.clips.length} clip(s). ¿Eliminar la pista y todos sus clips?`)
            )
              return
            c.removeTrack(track.id)
          }
        }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
      return
    }

    const hit = y >= layout.rulerHeight ? hitClip(x, y) : null
    if (hit && 'clip' in hit) {
      const clip = hit.clip as Clip
      // Keep an existing multi-selection when the clicked clip is part of it; otherwise select it.
      if (!selected.has(clip.id)) c.selectOnly(clip.id)
      const speedEntry = (v: number): MenuEntry => ({
        label: `${v}×`,
        checked: clip.speed === v,
        onClick: () => c.setClipSpeed(clip.id, v)
      })
      const items: MenuItem[] = [
        { label: 'Cortar', shortcut: 'Ctrl+X', onClick: () => store.cutSelection() },
        { label: 'Copiar', shortcut: 'Ctrl+C', onClick: () => store.copySelection() },
        { label: 'Pegar', shortcut: 'Ctrl+V', disabled: !store.hasClipboard, onClick: () => store.pasteAtFrame(frame) },
        { label: 'Duplicar', shortcut: 'Ctrl+D', onClick: () => store.duplicateSelection() },
        'separator',
        {
          label: 'Dividir aquí',
          shortcut: 'S',
          onClick: () => {
            if (c.splitClip(clip.id, frame) === null) c.splitAtPlayhead()
          }
        },
        { label: 'Eliminar', shortcut: 'Supr', onClick: () => c.removeClips(c.getSelectedClipIds()) },
        {
          label: 'Eliminar y cerrar hueco',
          onClick: () => {
            const res = c.rippleDelete(c.getSelectedClipIds())
            if (!res.ok && res.reason) flashNotice(res.reason)
          }
        },
        'separator',
        { label: 'Velocidad', submenu: [speedEntry(0.5), speedEntry(1), speedEntry(1.5), speedEntry(2)] },
        'separator',
        {
          label: 'Propiedades…',
          onClick: () => {
            c.selectOnly(clip.id)
            store.setRightTab('props')
          }
        },
        { label: 'Colorizar…', onClick: () => store.setColorInspectorOpen(true) },
        { label: 'Realzar audio…', onClick: () => store.setAudioInspectorOpen(true) }
      ]
      setMenu({ x: e.clientX, y: e.clientY, items })
      return
    }

    // Empty area / ruler → paste + track creation.
    const items: MenuItem[] = [
      { label: 'Pegar aquí', shortcut: 'Ctrl+V', disabled: !store.hasClipboard, onClick: () => store.pasteAtFrame(frame) },
      'separator',
      { label: 'Añadir pista de video', onClick: () => c.addTrack('video') },
      { label: 'Añadir pista de audio', onClick: () => c.addTrack('audio') }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  // --- Drag from media bin ---

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.types.includes('application/x-reelmind-asset')) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    const assetId = e.dataTransfer.getData('application/x-reelmind-asset')
    if (!assetId) return
    e.preventDefault()
    const entry = useEditorStore.getState().manifest.entries.find((x) => x.id === assetId)
    if (!entry) return
    const r = (canvasRef.current as HTMLCanvasElement).getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const frame = Math.max(0, frameForX(Math.max(layout.headerWidth, x), layout, scrollX))
    const durationFrames = defaultFramesFor(entry.type, entry.duration, timeline.fps)
    const c = getController()

    let ti = trackIndexForY(y, layout, timeline.tracks.length)
    const desiredType: ClipType = entry.type === 'audio' ? 'audio' : 'video'
    let trackId: string
    if (ti < 0 || ti >= timeline.tracks.length || !isCompatible(timeline.tracks[ti].type, desiredType)) {
      trackId = c.addTrack(desiredType)
    } else {
      trackId = timeline.tracks[ti].id
    }
    c.transact('Add Clip', () => {
      const id = c.addClip({
        trackId,
        mediaRef: entry.id,
        mediaType: entry.type,
        sourceClipType: entry.type,
        startFrame: frame,
        durationFrames
      })
      if (id) c.selectOnly(id)
    })
  }

  // --- Wheel: pan + ctrl-zoom ---

  function onWheel(e: React.WheelEvent<HTMLCanvasElement>): void {
    if (e.ctrlKey) {
      const r = (e.target as HTMLCanvasElement).getBoundingClientRect()
      const x = e.clientX - r.left
      const frameAtCursor = frameForX(Math.max(layout.headerWidth, x), layout, scrollX)
      const next = clamp(pixelsPerFrame * (e.deltaY < 0 ? 1.15 : 0.87), 0.5, 40)
      const nextScroll = Math.max(0, layout.headerWidth + frameAtCursor * next - x)
      setPixelsPerFrame(next)
      setScrollX(nextScroll)
    } else {
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
      setScrollX((s) => clamp(s + delta, 0, maxScrollX))
    }
  }

  // --- Toolbar actions ---

  const c = getController()
  const hasSelection = selectedClipIds.length > 0
  const noTracks = timeline.tracks.length === 0

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <button onClick={() => c.addTrack('video')}>+ Video track</button>
        <button onClick={() => c.addTrack('audio')}>+ Audio track</button>
        <span className="tl-sep" />
        <button disabled={!hasSelection} onClick={() => c.splitAtPlayhead()} title="Split at playhead (S)">
          Split
        </button>
        <button
          disabled={!hasSelection}
          onClick={() => {
            const r = c.rippleDelete(c.getSelectedClipIds())
            if (!r.ok && r.reason) flashNotice(r.reason)
          }}
          title="Ripple delete"
        >
          Ripple delete
        </button>
        <button disabled={!hasSelection} onClick={() => c.removeClips(c.getSelectedClipIds())} title="Delete (Del)">
          Delete
        </button>
        <span className="tl-sep" />
        <button onClick={() => setPixelsPerFrame((z) => clamp(z * 0.8, 0.5, 40))} title="Zoom out">
          −
        </button>
        <button onClick={() => setPixelsPerFrame((z) => clamp(z * 1.25, 0.5, 40))} title="Zoom in">
          +
        </button>
        <span className="tl-spacer" />
        {notice && <span className="tl-notice">{notice}</span>}
        <span className="tl-hint">
          {noTracks ? 'Drag media here to start' : 'Drag clips to move · edges to trim · S split · Del remove'}
        </span>
      </div>
      <div className="timeline-canvas-wrap" ref={wrapRef} onDragOver={onDragOver} onDrop={onDrop}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
          onDoubleClick={onDoubleClick}
        />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

// --- module helpers ---

function defaultFramesFor(type: ClipType, duration: number, fps: number): number {
  if (type === 'image') return Math.max(1, Math.round(5 * fps))
  if (type === 'text') return Math.max(1, Math.round(3 * fps))
  return Math.max(1, Math.round((duration || 5) * fps))
}

function clipBoxAt(start: number, duration: number, trackIndex: number, l: TimelineLayout, scrollX: number): ClipBox {
  return {
    x: xForFrame(start, l, scrollX),
    y: trackTop(trackIndex, l) + 3,
    w: Math.max(1, duration * l.pixelsPerFrame),
    h: l.trackHeight - 6
  }
}

function drawSnap(ctx: CanvasRenderingContext2D, x: number, l: TimelineLayout, height: number): void {
  ctx.save()
  ctx.strokeStyle = ACCENT
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(x, l.rulerHeight)
  ctx.lineTo(x, height)
  ctx.stroke()
  ctx.restore()
}

function nameFor(clip: Clip): string {
  if (clip.mediaType === 'text') return clip.textContent || 'Text'
  return clip.mediaRef
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
