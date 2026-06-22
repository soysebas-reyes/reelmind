// SPDX-License-Identifier: GPL-3.0-or-later
// Real-time preview: composites the visible clips at the playhead via the pure `composeFrame`,
// honoring track z-order, per-clip transform / crop / opacity. Playback advances the controller's
// playhead at the project fps. Visual sources use the per-asset poster/thumbnail; frame-accurate
// video decode (pooled <video> via a main-process media protocol) is the remaining P3 runtime piece.

import { useEffect, useRef, useState } from 'react'
import {
  type ColorAdjustments,
  colorIsIdentity,
  composeFrame,
  expectedPath,
  timelineFrameForSourceSeconds,
  volumeAt
} from '@core'
import { getController, timelineTotalFrames, useEditorStore } from '../store'

/** Approximate ColorAdjustments → Canvas 2D filter. CSS filters cover brightness/contrast/saturation/
 *  hue; temperature/tint/tonal/LUT are NOT representable here — the FFmpeg still/export is the exact
 *  reference. Intentionally a fast approximation for live scrubbing. */
function colorToCanvasFilter(c: ColorAdjustments): string {
  const parts: string[] = []
  const brightness = 1 + c.brightness + c.exposure * 0.1
  if (Math.abs(brightness - 1) > 1e-6) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (c.contrast !== 1) parts.push(`contrast(${c.contrast})`)
  if (c.saturation !== 1) parts.push(`saturate(${c.saturation})`)
  if (c.hue !== 0) parts.push(`hue-rotate(${c.hue}deg)`)
  return parts.length > 0 ? parts.join(' ') : 'none'
}

/** Renderer-usable URL for any media asset (video/audio), served by the main-process media protocol. */
function assetMediaUrl(mediaRef: string): string | null {
  const { manifest, projectDir } = useEditorStore.getState()
  const entry = manifest.entries.find((e) => e.id === mediaRef)
  if (!entry) return null
  const path = expectedPath(manifest, mediaRef, projectDir)
  return path ? `reelmind-media://local/${encodeURIComponent(path)}` : null
}

function timecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.round(frame))
  const totalSecs = Math.floor(f / fps)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  const ff = f % fps
  return `${m}:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`
}

export default function Preview(): React.JSX.Element {
  const timeline = useEditorStore((s) => s.timeline)
  const currentFrame = useEditorStore((s) => s.currentFrame)
  const thumbnails = useEditorStore((s) => s.thumbnails)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const drawRef = useRef<() => void>(() => {})
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [playing, setPlaying] = useState(false)
  const [exactUrl, setExactUrl] = useState<string | null>(null)

  const fps = timeline.fps
  const total = timelineTotalFrames(timeline)

  function imageFor(assetId: string): HTMLImageElement | null {
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
  }

  /** A pooled, decode-ready <video> for a video asset (off-DOM), or null if not a video / no path.
   *  Created unmuted; per-frame gain/mute is applied in the playback-sync effect below. */
  function videoFor(mediaRef: string): HTMLVideoElement | null {
    const url = assetMediaUrl(mediaRef)
    if (!url) return null
    const pool = videoPoolRef.current
    let v = pool.get(mediaRef)
    if (!v) {
      v = document.createElement('video')
      v.src = url
      v.muted = false
      v.preload = 'auto'
      v.playsInline = true
      v.addEventListener('loadeddata', () => drawRef.current())
      v.addEventListener('seeked', () => drawRef.current())
      pool.set(mediaRef, v)
    }
    return v
  }

  /** A pooled <audio> element for a pure-audio asset, fed by the same media protocol. */
  function audioFor(mediaRef: string): HTMLAudioElement | null {
    const url = assetMediaUrl(mediaRef)
    if (!url) return null
    const pool = audioPoolRef.current
    let a = pool.get(mediaRef)
    if (!a) {
      a = new Audio()
      a.src = url
      a.preload = 'auto'
      pool.set(mediaRef, a)
    }
    return a
  }

  /** Draw the real source (video frame if ready, else poster/thumbnail) with crop. */
  function drawSource(ctx: CanvasRenderingContext2D, mediaType: string, mediaRef: string, crop: { left: number; top: number; right: number; bottom: number }, dx: number, dy: number, dw: number, dh: number): boolean {
    const sw = (iw: number) => Math.max(1, iw * (1 - crop.left - crop.right))
    const sh = (ih: number) => Math.max(1, ih * (1 - crop.top - crop.bottom))
    if (mediaType === 'video') {
      const v = videoFor(mediaRef)
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        ctx.drawImage(v, crop.left * v.videoWidth, crop.top * v.videoHeight, sw(v.videoWidth), sh(v.videoHeight), dx, dy, dw, dh)
        return true
      }
    }
    const img = imageFor(mediaRef)
    if (img) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, crop.left * img.naturalWidth, crop.top * img.naturalHeight, sw(img.naturalWidth), sh(img.naturalHeight), dx, dy, dw, dh)
      return true
    }
    return false
  }

  function draw(): void {
    const cvs = canvasRef.current
    const ctx = cvs?.getContext('2d')
    if (!cvs || !ctx) return
    const { width, height } = size
    if (width === 0 || height === 0) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    // Letterbox the project frame into the panel.
    const pad = 14
    const availW = width - pad * 2
    const availH = height - pad * 2
    const aspect = timeline.width / timeline.height
    let fw = availW
    let fh = availW / aspect
    if (fh > availH) {
      fh = availH
      fw = availH * aspect
    }
    const fx = (width - fw) / 2
    const fy = (height - fh) / 2
    const sx = fw / timeline.width
    const sy = fh / timeline.height

    ctx.fillStyle = '#000'
    ctx.fillRect(fx, fy, fw, fh)

    const composed = composeFrame(timeline, currentFrame)
    for (const layer of composed.visual) {
      const t = layer.transform
      const w = t.width * timeline.width
      const h = t.height * timeline.height
      const cx = t.centerX * timeline.width
      const cy = t.centerY * timeline.height
      const dx = fx + (cx - w / 2) * sx
      const dy = fy + (cy - h / 2) * sy
      const dw = w * sx
      const dh = h * sy

      ctx.save()
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity))
      if (t.rotation) {
        const pivotX = fx + cx * sx
        const pivotY = fy + cy * sy
        ctx.translate(pivotX, pivotY)
        ctx.rotate((t.rotation * Math.PI) / 180)
        ctx.translate(-pivotX, -pivotY)
      }

      if (layer.mediaType === 'text') {
        ctx.fillStyle = '#ffffff'
        ctx.font = `${Math.max(12, Math.round(fh * 0.07))}px Segoe UI, system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(layer.textContent || 'Text', fx + cx * sx, fy + cy * sy, dw)
      } else {
        // Approximate color grade (P9.5). Reset by ctx.restore() at the end of this layer.
        const clip = timeline.tracks[layer.trackIndex]?.clips.find((c) => c.id === layer.clipId)
        if (clip?.color && !colorIsIdentity(clip.color)) ctx.filter = colorToCanvasFilter(clip.color)
        if (!drawSource(ctx, layer.mediaType, layer.mediaRef, layer.crop, dx, dy, dw, dh)) {
          ctx.filter = 'none'
          ctx.fillStyle = '#23232e'
          ctx.fillRect(dx, dy, dw, dh)
        }
      }
      ctx.restore()
    }

    ctx.strokeStyle = '#2c2c38'
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw, fh)
  }
  drawRef.current = draw

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
  }, [size, timeline, currentFrame, thumbnails])

  // Keep pooled media aligned with the playhead: when paused, seek to the exact source time
  // (the 'seeked' event redraws the real frame); when playing, let it play (best-effort sync).
  // Audio: drive the embedded track of visible video clips and every pure-audio layer, applying
  // per-clip gain (volume × fades) and track mute. The FFmpeg export stays the exact reference.
  useEffect(() => {
    const composed = composeFrame(timeline, currentFrame)
    const visibleVideos = new Set<string>()
    for (const layer of composed.visual) {
      if (layer.mediaType !== 'video') continue
      visibleVideos.add(layer.mediaRef)
      const v = videoFor(layer.mediaRef)
      if (!v) continue
      const track = timeline.tracks[layer.trackIndex]
      const clip = track?.clips.find((c) => c.id === layer.clipId)
      v.muted = track?.muted ?? false
      v.volume = clip ? Math.max(0, Math.min(1, volumeAt(clip, currentFrame))) : 1
      const target = Math.max(0, layer.sourceSeconds)
      if (playing) {
        if (v.paused) {
          if (Number.isFinite(v.duration)) v.currentTime = Math.min(target, v.duration)
          void v.play().catch(() => {})
        }
      } else {
        if (!v.paused) v.pause()
        if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.04) v.currentTime = target
      }
    }
    // Pause any pooled video that isn't on screen this frame.
    for (const [ref, v] of videoPoolRef.current) {
      if (!visibleVideos.has(ref) && !v.paused) v.pause()
    }

    // Pure-audio layers (music / voiceover). composeFrame already skips muted audio tracks and
    // bakes volume + fades into `gain`.
    const audibleAudio = new Set<string>()
    for (const a of composed.audio) {
      audibleAudio.add(a.mediaRef)
      const el = audioFor(a.mediaRef)
      if (!el) continue
      el.volume = Math.max(0, Math.min(1, a.gain))
      const target = Math.max(0, a.sourceSeconds)
      if (playing) {
        if (el.paused) {
          if (Number.isFinite(el.duration)) el.currentTime = Math.min(target, el.duration)
          void el.play().catch(() => {})
        }
      } else {
        if (!el.paused) el.pause()
        if (el.readyState >= 1 && Math.abs(el.currentTime - target) > 0.04) el.currentTime = target
      }
    }
    for (const [ref, el] of audioPoolRef.current) {
      if (!audibleAudio.has(ref) && !el.paused) el.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, playing, timeline])

  // Release pooled media on unmount.
  useEffect(() => {
    const vpool = videoPoolRef.current
    const apool = audioPoolRef.current
    return () => {
      for (const v of vpool.values()) {
        v.pause()
        v.removeAttribute('src')
        v.load()
      }
      vpool.clear()
      for (const a of apool.values()) {
        a.pause()
        a.removeAttribute('src')
        a.load()
      }
      apool.clear()
    }
  }, [])

  // Playback clock — the lead on-screen VIDEO is the master clock: the playhead follows its real
  // `currentTime`, so video, embedded audio, and the timecode stay locked across pause/resume (a
  // free timer would race ahead while a 4K seek catches up). Falls back to a timer only when no
  // video is playing (images / pure audio).
  useEffect(() => {
    if (!playing) return
    const c = getController()
    let last = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      const tl = c.getTimeline()
      const cur = c.getCurrentFrame()
      let frame: number | null = null
      for (const layer of composeFrame(tl, cur).visual) {
        if (layer.mediaType !== 'video') continue
        const v = videoPoolRef.current.get(layer.mediaRef)
        if (!v || v.paused) continue
        const clip = tl.tracks[layer.trackIndex]?.clips.find((cl) => cl.id === layer.clipId)
        const f = clip ? timelineFrameForSourceSeconds(clip, v.currentTime, fps) : null
        if (f !== null) {
          frame = f
          break
        }
      }
      if (frame === null) frame = Math.round(cur + dt * fps)
      if (total > 0 && frame >= total) {
        c.seek(total)
        setPlaying(false)
        return
      }
      c.seek(frame)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps, total])

  // Exact graded overlay when paused: the Canvas approximation can't show LUTs, so for a paused frame
  // whose top video clip carries a grade, render the precise frame (FFmpeg — same chain as the export)
  // and lay it over the canvas. Debounced; cleared while playing or when the frame is un-graded.
  useEffect(() => {
    if (playing) {
      setExactUrl(null)
      return
    }
    const { manifest, projectDir } = useEditorStore.getState()
    let req: { path: string; seconds: number; color: ColorAdjustments } | null = null
    for (const layer of composeFrame(timeline, currentFrame).visual) {
      if (layer.mediaType !== 'video') continue
      const clip = timeline.tracks[layer.trackIndex]?.clips.find((c) => c.id === layer.clipId)
      if (!clip?.color || colorIsIdentity(clip.color)) continue
      const path = expectedPath(manifest, layer.mediaRef, projectDir)
      if (path) {
        req = { path, seconds: Math.max(0, layer.sourceSeconds), color: clip.color }
        break
      }
    }
    if (!req) {
      setExactUrl(null)
      return
    }
    const r = req
    let cancelled = false
    const t = setTimeout(() => {
      void window.editorBridge
        .colorStill({ mediaPath: r.path, seekSeconds: r.seconds, color: r.color, width: 900, projectDir })
        .then((url) => {
          if (!cancelled) setExactUrl(url)
        })
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, playing, timeline])

  const togglePlay = (): void => {
    const c = getController()
    if (!playing && total > 0 && c.getCurrentFrame() >= total) c.seek(0)
    setPlaying((p) => !p)
  }

  return (
    <div className="preview">
      <div className="preview-stage" ref={wrapRef}>
        <canvas ref={canvasRef} />
        {!playing && exactUrl && <img className="preview-exact" src={exactUrl} alt="" />}
      </div>
      <div className="preview-transport">
        <button className="play" onClick={togglePlay} disabled={total === 0} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="tc">
          {timecode(currentFrame, fps)} <span className="tc-dim">/ {timecode(total, fps)}</span>
        </span>
        <input
          className="scrub"
          type="range"
          min={0}
          max={Math.max(1, total)}
          value={Math.min(currentFrame, Math.max(1, total))}
          onChange={(e) => getController().seek(Number(e.target.value))}
        />
        <span className="res">
          {timeline.width}×{timeline.height} · {fps}fps
        </span>
      </div>
    </div>
  )
}
