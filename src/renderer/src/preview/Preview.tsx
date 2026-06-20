// SPDX-License-Identifier: GPL-3.0-or-later
// Real-time preview: composites the visible clips at the playhead via the pure `composeFrame`,
// honoring track z-order, per-clip transform / crop / opacity. Playback advances the controller's
// playhead at the project fps. Visual sources use the per-asset poster/thumbnail; frame-accurate
// video decode (pooled <video> via a main-process media protocol) is the remaining P3 runtime piece.

import { useEffect, useRef, useState } from 'react'
import { composeFrame } from '@core'
import { getController, timelineTotalFrames, useEditorStore } from '../store'

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
  const drawRef = useRef<() => void>(() => {})
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [playing, setPlaying] = useState(false)

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
        const img = imageFor(layer.mediaRef)
        if (img) {
          const iw = img.naturalWidth
          const ih = img.naturalHeight
          const crop = layer.crop
          const srcX = crop.left * iw
          const srcY = crop.top * ih
          const srcW = Math.max(1, iw * (1 - crop.left - crop.right))
          const srcH = Math.max(1, ih * (1 - crop.top - crop.bottom))
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, srcX, srcY, srcW, srcH, dx, dy, dw, dh)
        } else {
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

  // Playback clock — advance the controller playhead at the project fps.
  useEffect(() => {
    if (!playing) return
    const c = getController()
    let last = performance.now()
    let acc = c.getCurrentFrame()
    let raf = 0
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      acc += dt * fps
      const f = Math.round(acc)
      if (total > 0 && f >= total) {
        c.seek(total)
        setPlaying(false)
        return
      }
      c.seek(f)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, fps, total])

  const togglePlay = (): void => {
    const c = getController()
    if (!playing && total > 0 && c.getCurrentFrame() >= total) c.seek(0)
    setPlaying((p) => !p)
  }

  return (
    <div className="preview">
      <div className="preview-stage" ref={wrapRef}>
        <canvas ref={canvasRef} />
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
