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
  visibleLayerSet,
  volumeAt
} from '@core'
import { getController, timelineTotalFrames, useEditorStore } from '../store'
import { applyAudioEnhance } from '../audio/audioGraph'
import { Icon } from '../ui/Icon'
import { type ColorGL, getColorGL } from './colorGL'

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
  // Prefer a preview proxy for video (smooth decode + reliable seeking on 4K/10-bit/4:2:2 sources).
  // Export still uses the original (main-process exporter resolves the source, not this URL).
  const path = entry.type === 'video' && entry.proxyPath ? entry.proxyPath : expectedPath(manifest, mediaRef, projectDir)
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
  // Subscribed so a proxy generated mid-session triggers a redraw → videoFor rebuilds with the proxy URL.
  const manifest = useEditorStore((s) => s.manifest)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const videoPoolRef = useRef<Map<string, HTMLVideoElement>>(new Map())
  // The media URL we last assigned per video mediaRef. Compared to detect a proxy swap WITHOUT reading
  // `video.src` (the browser returns a resolved/re-encoded form that never string-equals our custom URL,
  // which would otherwise rebuild the element every frame → frozen video).
  const videoUrlRef = useRef<Map<string, string>>(new Map())
  const audioPoolRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  // Source time (seconds) we still owe a media element once it becomes seekable. Set when we tried to
  // seek before metadata/duration were known; applied in the element's loadeddata/canplay handler so a
  // freshly-shown angle never plays from 0 before jumping (the "always starts from the beginning" bug).
  const pendingSeekRef = useRef<Map<HTMLMediaElement, number>>(new Map())
  // The clip-segment each pooled element is currently aligned to. Lets us seek ONCE when the active
  // segment for a source changes (a multicam jump) instead of re-seeking every tick (which restarted
  // in-flight proxy seeks → "repeats the same shot / never advances").
  const alignRef = useRef<Map<HTMLMediaElement, string>>(new Map())
  // Video elements that have produced at least one frame. Lets us keep drawing a clip's LAST frame during
  // a brief seek instead of falling back to its poster (a fixed early frame) — which read as the angle
  // "jumping back to the start" at every cut.
  const videoReadyRef = useRef<Set<HTMLVideoElement>>(new Set())
  const drawRef = useRef<() => void>(() => {})
  // LUT load state per lutRef: 'loading' (in flight) / 'ready' / 'failed' (retried later). Once a LUT
  // is uploaded to the GL renderer, gl.hasLut is the source of truth; this just gates the async fetch.
  const lutStateRef = useRef<Map<string, 'loading' | 'ready' | 'failed'>>(new Map())
  // Live playhead during playback. The rAF loop advances this and draws directly, pushing it into the
  // store (→ React re-render for the timecode/scrubber) only ~10×/s instead of every frame — the
  // per-frame setState was a big chunk of the playback jank. Refs so the rAF/draw closures read fresh.
  const playheadRef = useRef(0)
  const playingRef = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 0 })
  // Play/pause lives in the store (togglePlayback) so Space and other panels can drive it; this
  // component keeps its refs/effect structure and just reads the flag.
  const playing = useEditorStore((s) => s.isPlaying)
  // Preview-only playback rate (0.5×/1×/2×). Multiplies the clock AND every media playbackRate; the
  // export is untouched. Changing it re-anchors the clock (it's in the clock effect's deps).
  const [previewRate, setPreviewRate] = useState(1)

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
    // Rebuild only if the URL WE assigned changed (e.g. a preview proxy was just generated) — never
    // compare against `v.src` (resolved form differs from our custom URL → would rebuild every frame).
    if (v && videoUrlRef.current.get(mediaRef) !== url) {
      v.pause()
      v.removeAttribute('src')
      v.load()
      pool.delete(mediaRef)
      pendingSeekRef.current.delete(v)
      alignRef.current.delete(v)
      videoReadyRef.current.delete(v)
      v = undefined
    }
    if (!v) {
      v = document.createElement('video')
      // Origin-clean (with the media protocol's CORS header) so WebGL can sample frames untainted.
      v.crossOrigin = 'anonymous'
      v.src = url
      v.muted = false
      v.preload = 'auto'
      v.playsInline = true
      v.preservesPitch = true // pitch lock: speed changes (playbackRate) keep the voice's pitch
      // Apply any deferred seek as soon as the element can seek, THEN draw — so a just-shown angle
      // lands on its synced source time instead of flashing/playing from frame 0.
      v.addEventListener('loadeddata', (e) => {
        applyPendingSeek(e.currentTarget as HTMLMediaElement)
        drawRef.current()
      })
      v.addEventListener('canplay', (e) => applyPendingSeek(e.currentTarget as HTMLMediaElement))
      v.addEventListener('seeked', () => drawRef.current())
      pool.set(mediaRef, v)
      videoUrlRef.current.set(mediaRef, url)
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
      // Origin-clean (the media protocol sends a CORS header) so a MediaElementAudioSourceNode in the
      // enhance graph receives real samples — without this, Web Audio routes cross-origin media as SILENCE.
      a.crossOrigin = 'anonymous'
      a.src = url
      a.preload = 'auto'
      a.preservesPitch = true // pitch lock on speed changes
      a.addEventListener('loadeddata', (e) => applyPendingSeek(e.currentTarget as HTMLMediaElement))
      a.addEventListener('canplay', (e) => applyPendingSeek(e.currentTarget as HTMLMediaElement))
      pool.set(mediaRef, a)
    }
    return a
  }

  /** Clamp a source time just inside the element's known duration (no-op when duration is unknown). */
  function clampSeek(el: HTMLMediaElement, t: number): number {
    return Number.isFinite(el.duration) ? Math.min(t, Math.max(0, el.duration - 0.05)) : Math.max(0, t)
  }

  /** Apply a deferred seek once the element is loaded (called from loadeddata/canplay), then resume
   *  playback if we're playing — so we never play from 0 and jump. */
  function applyPendingSeek(el: HTMLMediaElement): void {
    const t = pendingSeekRef.current.get(el)
    if (t === undefined) return
    pendingSeekRef.current.delete(el)
    el.currentTime = clampSeek(el, t)
    if (playingRef.current && el.paused) void el.play().catch(() => {})
  }

  /** Seek `el` to source time `t`. If it isn't seekable yet (metadata not loaded), defer the seek until
   *  it is (and DON'T play yet) so a freshly-shown angle never flashes/plays from frame 0. When already
   *  seekable, seek now (unless a seek is already in flight) and resume if `play`. */
  function requestSeekAndPlay(el: HTMLMediaElement, t: number, play: boolean): void {
    if (el.readyState >= 1) {
      if (!el.seeking) el.currentTime = clampSeek(el, t)
      if (play && el.paused) void el.play().catch(() => {})
    } else {
      pendingSeekRef.current.set(el, t)
    }
  }

  /** True once this <video> is paintable: it has a current frame (readyState>=2) OR produced one before
   *  — so drawImage shows its LAST frame during a brief seek instead of us falling back to the poster. */
  function videoDrawable(v: HTMLVideoElement): boolean {
    if (v.videoWidth <= 0) return false
    if (v.readyState >= 2) {
      videoReadyRef.current.add(v)
      return true
    }
    return videoReadyRef.current.has(v)
  }

  /** The decode-ready element to feed the WebGL grade: the video frame if ready, else the poster. */
  function gradeSourceFor(mediaType: string, mediaRef: string): TexImageSource | null {
    if (mediaType === 'video') {
      const v = videoFor(mediaRef)
      if (v && videoDrawable(v)) return v
    }
    return imageFor(mediaRef)
  }

  /** Ensure a clip's LUT is resident in the GL renderer: kicks an async fetch on first need and
   *  redraws when it lands. Returns true only once the texture is uploaded. A miss is retried after a
   *  delay (so configuring the LUT folder mid-session self-heals) without re-requesting every frame. */
  function ensureLut(gl: ColorGL, lutRef: string): boolean {
    if (gl.hasLut(lutRef)) return true
    if (lutStateRef.current.get(lutRef)) return false // 'loading' or 'failed'
    lutStateRef.current.set(lutRef, 'loading')
    const { projectDir } = useEditorStore.getState()
    void window.editorBridge.colorLutData({ lutRef, projectDir }).then((res) => {
      if (res && res.size > 0) {
        gl.setLut(lutRef, res.size, new Float32Array(res.data))
        lutStateRef.current.set(lutRef, 'ready')
      } else {
        lutStateRef.current.set(lutRef, 'failed')
        window.setTimeout(() => lutStateRef.current.delete(lutRef), 3000)
      }
      drawRef.current()
    })
    return false
  }

  /** Draw the real source (video frame if ready, else poster/thumbnail) with crop. */
  function drawSource(ctx: CanvasRenderingContext2D, mediaType: string, mediaRef: string, crop: { left: number; top: number; right: number; bottom: number }, dx: number, dy: number, dw: number, dh: number): boolean {
    const sw = (iw: number) => Math.max(1, iw * (1 - crop.left - crop.right))
    const sh = (ih: number) => Math.max(1, ih * (1 - crop.top - crop.bottom))
    if (mediaType === 'video') {
      const v = videoFor(mediaRef)
      if (v && videoDrawable(v)) {
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

    // While playing, draw the live playhead (advanced by the rAF loop) rather than the throttled store
    // frame, so playback stays smooth even though the store only updates ~10×/s.
    const frame = playingRef.current ? playheadRef.current : currentFrame
    const composed = composeFrame(timeline, frame)
    // Skip layers fully hidden behind an opaque full-frame clip above (pixel-identical result,
    // and it avoids the WebGL grade pass for the occluded angle in a multicam stack). Text always draws.
    const drawn = visibleLayerSet(composed.visual)
    for (const layer of composed.visual) {
      if (layer.mediaType !== 'text' && !drawn.has(layer.mediaRef)) continue
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
        // Color grade (P9.5). WebGL path applies the FULL grade incl. the 3D `.cube` LUT live (so
        // playback/scrub match the export — §9.5.12); on any failure (or un-graded / no WebGL2) it
        // falls back to the Canvas-2D CSS-filter approximation. ctx.filter is reset by restore().
        const clip = timeline.tracks[layer.trackIndex]?.clips.find((c) => c.id === layer.clipId)
        const color = clip?.color
        const graded = !!color && !colorIsIdentity(color)
        let painted = false
        if (graded && color) {
          const gl = getColorGL()
          const glSource = gl ? gradeSourceFor(layer.mediaType, layer.mediaRef) : null
          if (gl && glSource) {
            try {
              const lutKey = color.lutRef && ensureLut(gl, color.lutRef) ? color.lutRef : null
              const outW = Math.max(1, Math.round(dw * dpr))
              const outH = Math.max(1, Math.round(dh * dpr))
              const g = gl.render(glSource, layer.crop, color, lutKey, outW, outH)
              if (g) {
                ctx.drawImage(g, dx, dy, dw, dh)
                painted = true
              }
            } catch {
              painted = false // fall through to the approximation below
            }
          }
        }
        if (!painted) {
          if (graded && color) ctx.filter = colorToCanvasFilter(color)
          if (!drawSource(ctx, layer.mediaType, layer.mediaRef, layer.crop, dx, dy, dw, dh)) {
            ctx.filter = 'none'
            ctx.fillStyle = '#23232e'
            ctx.fillRect(dx, dy, dw, dh)
          }
        }
      }
      ctx.restore()
    }

    ctx.strokeStyle = '#2c2c38'
    ctx.strokeRect(fx + 0.5, fy + 0.5, fw, fh)
  }
  drawRef.current = draw

  // Keep the refs the rAF/draw closures read in sync with React state.
  useEffect(() => {
    playingRef.current = playing
  }, [playing])
  useEffect(() => {
    if (!playing) playheadRef.current = currentFrame
  }, [currentFrame, playing])

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
  }, [size, timeline, currentFrame, thumbnails, manifest])

  // Keep pooled media aligned with the playhead: when paused, seek to the exact source time
  // (the 'seeked' event redraws the real frame); when playing, let it play (best-effort sync).
  // Audio: drive the embedded track of visible video clips and every pure-audio layer, applying
  // per-clip gain (volume × fades) and track mute. The FFmpeg export stays the exact reference.
  useEffect(() => {
    const composed = composeFrame(timeline, currentFrame)
    // Only the angles that actually contribute pixels need to decode. A video fully occluded by an
    // opaque full-frame clip above (e.g. the lower angle in a synced multicam stack) is paused, so
    // sync verification decodes one stream instead of two. Re-evaluated per frame, so a cut that
    // exposes the lower angle un-culls it automatically.
    const drawnRefs = visibleLayerSet(composed.visual)
    const visibleVideos = new Set<string>()
    for (const layer of composed.visual) {
      if (layer.mediaType !== 'video') continue
      const v = videoFor(layer.mediaRef)
      if (!v) continue
      if (!drawnRefs.has(layer.mediaRef)) {
        if (!v.paused) v.pause() // occluded — don't decode it (stays loaded for an instant un-cull)
        continue
      }
      visibleVideos.add(layer.mediaRef)
      const track = timeline.tracks[layer.trackIndex]
      const clip = track?.clips.find((c) => c.id === layer.clipId)
      v.muted = track?.muted ?? false
      v.volume = clip ? Math.max(0, Math.min(1, volumeAt(clip, currentFrame))) : 1
      // Play at the clip's speed (so a sped/slowed clip stays in sync with the timeline) with pitch
      // preserved (preservesPitch set at creation). The master clock divides currentTime by speed.
      const rate = Math.max(0.0625, Math.min(16, (clip?.speed ?? 1) * previewRate))
      if (v.playbackRate !== rate) v.playbackRate = rate
      const target = Math.max(0, layer.sourceSeconds)
      if (playing) {
        // Seek ONLY when the element (re)appears (was paused) or the active segment for this source
        // CHANGED (a multicam jump). Then let it play its contiguous segment freely. The !v.seeking +
        // alignRef guards mean exactly one seek per jump — we never restart an in-flight (slow proxy)
        // seek, which is what made it "repeat the same shot / never advance". A seek before the element
        // is loaded is deferred so it never plays from 0 ("always starts from the beginning").
        const mustSeek = v.paused || alignRef.current.get(v) !== layer.clipId
        if (mustSeek) {
          if (!v.seeking) {
            requestSeekAndPlay(v, target, true)
            alignRef.current.set(v, layer.clipId)
          }
        } else if (v.paused && !v.seeking) {
          void v.play().catch(() => {})
        }
      } else {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - target) > 0.04) requestSeekAndPlay(v, target, false)
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
      const aClip = timeline.tracks[a.trackIndex]?.clips.find((c) => c.id === a.clipId)
      const aSpeed = aClip?.speed ?? 1
      const aRate = Math.max(0.0625, Math.min(16, aSpeed * previewRate))
      if (el.playbackRate !== aRate) el.playbackRate = aRate
      // Non-destructive voice enhancement, audible live (EQ/compressor/limiter/gain). afftdn/gate/loudnorm
      // are applied exactly on export; here we approximate so slider changes are heard during playback.
      applyAudioEnhance(el, aClip?.audioEnhance)
      const target = Math.max(0, a.sourceSeconds)
      if (playing) {
        // Same policy as video: the synced audio is one continuous clip, so it seeks once (deferred
        // until loaded → starts at its trimStart, not 0) and then plays freely with no per-tick re-seek.
        const mustSeek = el.paused || alignRef.current.get(el) !== a.clipId
        if (mustSeek) {
          if (!el.seeking) {
            requestSeekAndPlay(el, target, true)
            alignRef.current.set(el, a.clipId)
          }
        } else if (el.paused && !el.seeking) {
          void el.play().catch(() => {})
        }
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - target) > 0.04) requestSeekAndPlay(el, target, false)
      }
    }
    for (const [ref, el] of audioPoolRef.current) {
      if (!audibleAudio.has(ref) && !el.paused) el.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFrame, playing, timeline, previewRate])

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
      pendingSeekRef.current.clear()
      alignRef.current.clear()
      videoReadyRef.current.clear()
    }
  }, [])

  // Playback clock — a monotonic wall-clock timer ANCHORED at the frame where play (re)started. The
  // playhead advances smoothly and can never snap back to 0 on resume (the anchor is the paused frame,
  // not the video's currentTime). The pooled <video>/<audio> elements play freely (slaved by the sync
  // effect), so audio↔video lip-sync comes straight from the media; this timer only drives the playhead,
  // timecode, and which clips composite. draw() samples whatever frame the (culled to one) video decoded.
  useEffect(() => {
    if (!playing) return
    const c = getController()
    const startWall = performance.now()
    const startFrame = playheadRef.current
    let lastSync = 0
    let raf = 0
    let cancelled = false
    const tick = (now: number): void => {
      if (cancelled) return
      const frame = startFrame + ((now - startWall) / 1000) * fps * previewRate
      if (total > 0 && frame >= total) {
        playheadRef.current = total
        c.seek(total)
        useEditorStore.getState().setPlaying(false)
        return
      }
      playheadRef.current = frame
      drawRef.current() // draw from the live playhead (no React re-render in the hot path)
      // Push to the store ~10×/s so the timecode + scrubber follow without a per-frame re-render.
      if (now - lastSync > 100) {
        lastSync = now
        c.seek(Math.round(frame))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [playing, fps, total, previewRate])

  const togglePlay = (): void => {
    useEditorStore.getState().togglePlayback()
  }

  const stepFrame = (delta: number): void => {
    if (playing) useEditorStore.getState().setPlaying(false)
    const c = getController()
    c.seek(c.getCurrentFrame() + delta)
  }

  return (
    <div className="preview">
      <div className="preview-stage" ref={wrapRef} onClick={() => total > 0 && togglePlay()}>
        <canvas ref={canvasRef} />
      </div>
      <div className="preview-transport">
        <button className="step" onClick={() => stepFrame(-1)} disabled={total === 0} title="Frame anterior (←)">
          <Icon name="play" size={11} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <button className="play" onClick={togglePlay} disabled={total === 0} title={playing ? 'Pausa' : 'Reproducir (Espacio)'}>
          <Icon name={playing ? 'pause' : 'play'} size={17} />
        </button>
        <button className="step" onClick={() => stepFrame(1)} disabled={total === 0} title="Frame siguiente (→)">
          <Icon name="play" size={11} />
        </button>
        <button
          className="rate"
          onClick={() => setPreviewRate((r) => (r === 1 ? 2 : r === 2 ? 0.5 : 1))}
          title="Velocidad de reproducción del preview (no afecta la exportación)"
        >
          {previewRate}×
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
