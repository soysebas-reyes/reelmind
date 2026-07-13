// SPDX-License-Identifier: GPL-3.0-or-later
// Editable visual preview for "Segmentar por guiones". Shows the WHOLE raw clip with one colored region
// per detected guión over a single full-duration track. The user drags each region's start/end handles
// (or types m:ss, snaps to the playhead, or nudges by frame) to set — with human judgment — exactly where
// each guión begins and ends. Edits write straight to `plan.takes[i].startMs/endMs` via `setTakeBounds`,
// which `applyTakesPlan` already consumes, so the opened tabs reflect the adjusted spans with no extra glue.
//
// Design notes:
//  · Takes are ABSOLUTE SOURCE ms. The preview shows a VIDEO angle; if the transcribed clip was the
//    optimized AUDIO, the take ms are offset-mapped to the video's source time by a constant `deltaSec`.
//  · Regions are INDEPENDENT: gaps (footage owned by no guión) and overlaps (shared footage) are allowed.
//  · The coordinate space is the ref clip's VISIBLE source window [visStartMs, visEndMs] — exactly the range
//    `buildTakeTimeline` can produce — so a boundary set here maps to the opened tab with no "inicio cortado".

import { useEffect, useMemo, useRef, useState } from 'react'
import { expectedPath, mediaUrlForPath } from '@core'
import type { PlannedTake } from '@core'
import type { Clip } from '@core'
import { useEditorStore } from '../store'
import { mmss, parseMmss } from './format'

type Edge = 'start' | 'end'

// Distinct hues per guión. Tokens first, then a few extra system colors for >6 guiones. Keyed off the
// stable `scriptIndex`/`index` so a region keeps its color when sorted/dimmed/re-accepted.
const REGION_COLORS = ['var(--accent)', 'var(--green)', 'var(--orange)', 'var(--red)', '#bf5af2', '#64d2ff']
function regionColor(take: PlannedTake, i: number): string {
  return REGION_COLORS[(take.scriptIndex ?? i) % REGION_COLORS.length]
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

export function TakesPreview(): React.JSX.Element | null {
  const plan = useEditorStore((s) => s.takesPlan)
  const manifest = useEditorStore((s) => s.manifest)
  const projectDir = useEditorStore((s) => s.projectDir)
  const timeline = useEditorStore((s) => s.timeline)
  const thumbnails = useEditorStore((s) => s.thumbnails)
  const optimizePlayback = useEditorStore((s) => s.optimizePlayback)
  const setTakeBounds = useEditorStore((s) => s.setTakeBounds)
  const setCutAccepted = useEditorStore((s) => s.setCutAccepted)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ idx: number; edge: Edge } | null>(null)
  // Coalesce live scrubs to one seek per animation frame — setting currentTime on every pointermove
  // queues seeks and stutters, badly on a 4K raw file.
  const seekTargetRef = useRef<number | null>(null)
  const seekRafRef = useRef<number | null>(null)
  // While "Reproducir región" is active, auto-pause once playback passes the region end (ms).
  const playRegionEndRef = useRef<number | null>(null)

  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [mediaError, setMediaError] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState(0)

  const durationMs = plan?.durationMs ?? 0
  const fps = plan?.fps || timeline.fps || 30
  const frameMs = 1000 / fps
  const snapMs = (ms: number): number => (Math.round((ms / 1000) * fps) * 1000) / fps

  // Resolve WHAT to show and HOW to map time. In the real flow the transcribed clip is the optimized
  // AUDIO track, so `rawMediaRef` is an audio entry — feeding that to <video> shows no picture. We instead
  // display a VIDEO angle and offset-map the take ms (audio timebase) to the video's source time. Both the
  // audio and the video sit on the synced timeline at startFrame 0 with the sync offset in trimStartFrame,
  // so the relationship is the constant `deltaSec`: videoSourceSec = takeMs/1000 + deltaSec.
  const source = useMemo(() => {
    if (!plan) return null
    const f = plan.fps || timeline.fps || 30
    let refClip: Clip | undefined
    for (const t of timeline.tracks) {
      const c = t.clips.find((x) => x.id === plan.rawClipId) ?? t.clips.find((x) => x.mediaRef === plan.rawMediaRef)
      if (c) {
        refClip = c
        break
      }
    }
    // Choose the VIDEO clip to display. Preference: the transcribed clip if it's video, then the frontal
    // angle, then any other angle — but among those PREFER one that already has a decodable proxy. Camera
    // 4K originals without a proxy render black in <video>, so a synced angle that HAS a proxy is a far
    // better preview than a black "frontal": all angles are synced, so the timing shown is identical, and
    // `deltaSec` corrects the source-time offset between the transcribed clip and whichever angle we show.
    const hasProxyFor = (clip: Clip): boolean => {
      const e = manifest.entries.find((x) => x.id === clip.mediaRef)
      return e?.type === 'video' && !!e.proxyPath
    }
    const videoTracks = timeline.tracks.filter((t) => t.type === 'video' && t.clips.length > 0)
    const frontal = videoTracks.find((t) => t.role === 'frontal')
    const ordered: Clip[] = []
    const pushClip = (c?: Clip): void => {
      if (c && !ordered.some((x) => x.id === c.id)) ordered.push(c)
    }
    if (refClip && refClip.mediaType === 'video') pushClip(refClip)
    pushClip(frontal?.clips[0])
    for (const t of videoTracks) pushClip(t.clips[0])
    const displayClip: Clip | undefined = ordered.find(hasProxyFor) ?? ordered[0]
    const deltaSec = refClip && displayClip ? (displayClip.trimStartFrame - refClip.trimStartFrame) / f : 0
    // The ref clip's VISIBLE source window (ms) — what the multicam-synced timeline actually contains after
    // its head/tail trim. Take boundaries MUST stay inside this window: `buildTakeTimeline` maps source-ms →
    // timeline frames through this same clip and CLAMPS anything outside it. So if the preview let the user
    // place a start in the trimmed-off head, the opened tab would begin later than shown ("inicio cortado").
    // Constraining the preview's coordinate space to [visStartMs, visEndMs] keeps preview and tab identical.
    const visStartMs = refClip ? (refClip.trimStartFrame / f) * 1000 : 0
    const visEndMs = refClip ? ((refClip.trimStartFrame + refClip.durationFrames * refClip.speed) / f) * 1000 : 0
    const entry = displayClip ? manifest.entries.find((e) => e.id === displayClip!.mediaRef) : undefined
    // For VIDEO, only ever feed a PROXY to <video> — camera 4K/10-bit/4:2:2 XAVC originals don't decode
    // in Chromium (they render black). No proxy yet → url null → the UI shows the poster + a generate
    // affordance instead of a broken/black <video>. Non-video (unused here) still resolves its source.
    const path =
      entry && displayClip
        ? entry.type === 'video'
          ? (entry.proxyPath ?? null)
          : expectedPath(manifest, displayClip.mediaRef, projectDir)
        : null
    const url = path ? mediaUrlForPath(path) : null
    // How many DISTINCT video angles used by the timeline still lack a proxy. Each opened guión tab inherits
    // the (whole-video) proxies via the cloned manifest and just plays its trimmed span — so a proxy is
    // reused across ALL tabs, never regenerated per guión. But an angle with NO proxy makes every tab prompt
    // (and regenerate in isolation). So we offer to generate the missing ones ONCE here, before creating tabs.
    const seenRefs = new Set<string>()
    let anglesMissingProxy = 0
    for (const t of videoTracks) {
      for (const c of t.clips) {
        if (seenRefs.has(c.mediaRef)) continue
        seenRefs.add(c.mediaRef)
        const en = manifest.entries.find((x) => x.id === c.mediaRef)
        if (en?.type === 'video' && !en.proxyPath) anglesMissingProxy++
      }
    }
    return {
      url,
      deltaSec,
      visStartMs,
      visEndMs,
      isVideo: entry?.type === 'video',
      hasProxy: entry?.type === 'video' ? !!entry.proxyPath : false,
      anglesMissingProxy,
      mediaRef: displayClip?.mediaRef ?? null
    }
  }, [timeline, plan, manifest, projectDir])

  const mediaUrl = source?.url ?? null
  const isVideo = source?.isVideo ?? false
  const hasProxy = source?.hasProxy ?? false
  const anglesMissingProxy = source?.anglesMissingProxy ?? 0
  const deltaSec = source?.deltaSec ?? 0
  const poster = source?.mediaRef ? (thumbnails[source.mediaRef] ?? undefined) : undefined
  // Coordinate space = the ref clip's visible source window (falls back to the transcript length).
  const winStart = source?.visStartMs ?? 0
  const winEndRaw = source?.visEndMs ?? 0
  const winEnd = winEndRaw > winStart ? winEndRaw : Math.max(winStart + 1, durationMs)
  const span = Math.max(1, winEnd - winStart)
  const clampWin = (ms: number): number => Math.max(winStart, Math.min(winEnd, ms))
  const fracToMs = (frac: number): number => winStart + clamp01(frac) * span
  const msToPct = (ms: number): number => clamp01((ms - winStart) / span) * 100

  // Reset transient state when the source changes (e.g. a re-segment replaced the plan).
  useEffect(() => {
    setCurrentMs(0)
    setPlaying(false)
    setMediaError(false)
    setSelectedIdx(0)
  }, [mediaUrl])

  // Keep the pooled element quiet on unmount so the media protocol releases the file handle (Windows lock).
  useEffect(() => {
    const v = videoRef.current
    return () => {
      if (v) {
        v.pause()
        v.removeAttribute('src')
        v.load()
      }
    }
  }, [])

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted
  }, [muted, mediaUrl])

  // Diagnostic (verification aid): surface why the preview video didn't resolve. Fires only when the
  // resolved source changes, not on every boundary edit.
  useEffect(() => {
    if (source && !source.url) {
      console.warn('[reelmind] takes-preview: no se pudo resolver el medio del video', {
        rawClipId: plan?.rawClipId,
        rawMediaRef: plan?.rawMediaRef,
        isVideo: source.isVideo
      })
    }
  }, [source?.url, source?.isVideo]) // eslint-disable-line react-hooks/exhaustive-deps

  // Smooth playhead while playing (timeupdate alone is ~4/s and looks choppy). Also enforces the
  // "Reproducir región" auto-pause. Paused scrubs are covered by onTimeUpdate/onSeeked instead.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      const v = videoRef.current
      if (v) {
        const ms = v.currentTime * 1000 - deltaSec * 1000 // video source time → take-ms coordinates
        setCurrentMs(ms)
        if (playRegionEndRef.current != null && ms >= playRegionEndRef.current) {
          v.pause()
          playRegionEndRef.current = null
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, deltaSec])

  if (!plan) return null

  const takes = plan.takes
  const selected = selectedIdx >= 0 && selectedIdx < takes.length ? takes[selectedIdx] : null

  // Take-ms (audio timebase) → the display video's source seconds.
  const videoSecFor = (ms: number): number => ms / 1000 + deltaSec

  const scheduleSeek = (ms: number): void => {
    seekTargetRef.current = ms
    if (seekRafRef.current != null) return
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = null
      const v = videoRef.current
      const t = seekTargetRef.current
      if (v && t != null) {
        try {
          v.currentTime = videoSecFor(t)
        } catch {
          /* not seekable yet */
        }
      }
    })
  }

  const seekTo = (ms: number): void => {
    const c = clampWin(ms)
    const v = videoRef.current
    if (v) {
      try {
        v.currentTime = videoSecFor(c)
      } catch {
        /* not seekable yet */
      }
    }
    setCurrentMs(c)
  }

  const seekToClientX = (clientX: number): void => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    seekTo(fracToMs((clientX - rect.left) / rect.width))
  }

  // Clamp the MOVING edge against the fixed one AND the clip's visible window, so start/end can't cross,
  // collapse below a frame, or land outside what the created tab can contain.
  const clampEdge = (take: PlannedTake, edge: Edge, ms: number): number =>
    edge === 'start' ? Math.max(winStart, Math.min(ms, take.endMs - frameMs)) : Math.min(winEnd, Math.max(ms, take.startMs + frameMs))

  // Discrete edits (drag release, numeric entry, nudge, "usar posición actual"). Seeks the video to the
  // committed edge so the user sees the exact frame the boundary now lands on. Live drag uses setTakeBounds
  // + scheduleSeek directly (throttled) instead of this.
  const setEdge = (idx: number, edge: Edge, ms: number, snap: boolean): void => {
    const take = takes[idx]
    if (!take) return
    const v = clampEdge(take, edge, snap ? snapMs(ms) : ms)
    if (edge === 'start') setTakeBounds(idx, v, take.endMs)
    else setTakeBounds(idx, take.startMs, v)
    seekTo(v)
  }

  // ── Drag (pointer capture keeps moves flowing even when the cursor leaves the small handle) ──
  const onHandleDown = (e: React.PointerEvent, idx: number, edge: Edge): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { idx, edge }
    setSelectedIdx(idx)
    const v = videoRef.current
    if (v && !v.paused) v.pause() // scrubbing a playing element is janky
  }
  const onHandleMove = (e: React.PointerEvent, idx: number, edge: Edge): void => {
    const d = dragRef.current
    if (!d || d.idx !== idx || d.edge !== edge) return
    const track = trackRef.current
    const take = takes[idx]
    if (!track || !take) return
    const rect = track.getBoundingClientRect()
    const ms = clampEdge(take, edge, fracToMs((e.clientX - rect.left) / rect.width))
    if (edge === 'start') setTakeBounds(idx, ms, take.endMs)
    else setTakeBounds(idx, take.startMs, ms)
    scheduleSeek(ms) // show the exact frame under the boundary as it moves
  }
  const onHandleUp = (e: React.PointerEvent, idx: number, edge: Edge): void => {
    if (dragRef.current) {
      const take = takes[idx]
      if (take) setEdge(idx, edge, edge === 'start' ? take.startMs : take.endMs, true) // snap to frame grid on release
    }
    dragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }

  // Keep each cut's GLOBAL index (gi) so a marker click toggles the right cutAccepted slot.
  const cutsFor = (index: number): { c: (typeof plan.cuts)[number]; gi: number }[] =>
    plan.cuts.map((c, gi) => ({ c, gi })).filter(({ c }) => c.takeIndex === index)

  const togglePlay = (): void => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      playRegionEndRef.current = null
      void v.play().catch(() => {}) // a quick pause()/seek can interrupt a pending play() → benign AbortError
    } else v.pause()
  }
  const playRegion = (): void => {
    const v = videoRef.current
    if (!v || !selected) return
    try {
      v.currentTime = videoSecFor(clampWin(selected.startMs))
    } catch {
      /* not seekable yet */
    }
    playRegionEndRef.current = clampWin(selected.endMs)
    void v.play().catch(() => {}) // a quick pause()/seek can interrupt a pending play() → benign AbortError
  }
  const nudge = (edge: Edge, dir: 1 | -1): void => {
    const take = takes[selectedIdx]
    if (!take) return
    setEdge(selectedIdx, edge, (edge === 'start' ? take.startMs : take.endMs) + dir * frameMs, true)
  }

  return (
    <div className="takes-preview" onPointerDown={(e) => e.stopPropagation()}>
      {mediaUrl && isVideo && !mediaError ? (
        <div className="takes-preview-videowrap">
          <video
            ref={videoRef}
            className="takes-preview-video"
            src={mediaUrl}
            poster={poster}
            crossOrigin="anonymous"
            playsInline
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onTimeUpdate={() => {
              if (!playing) setCurrentMs((videoRef.current?.currentTime ?? 0) * 1000 - deltaSec * 1000)
            }}
            onSeeked={() => setCurrentMs((videoRef.current?.currentTime ?? 0) * 1000 - deltaSec * 1000)}
            onError={() => {
              setMediaError(true)
              console.warn('[reelmind] takes-preview: el <video> no pudo cargar', mediaUrl)
            }}
          />
          {anglesMissingProxy > 0 && (
            <div className="takes-preview-proxyhint">
              <span>
                {anglesMissingProxy === 1 ? 'Falta el proxy de 1 ángulo' : `Faltan los proxies de ${anglesMissingProxy} ángulos`}. Sin
                él, cada pestaña de guión se verá en negro y te pedirá generarlo por separado. Generalo una vez acá: el mismo proxy del
                video completo se reutiliza en todas las pestañas (no se regenera por guión, no afecta la exportación).
              </span>
              <button className="primary" onClick={() => void optimizePlayback()}>
                Optimizar reproducción
              </button>
            </div>
          )}
        </div>
      ) : isVideo && (!hasProxy || mediaError) ? (
        // Video angle without a usable proxy (still generating, failed, or reopened before regen). Show
        // the poster + a generate affordance instead of a black <video> — the raw 4K won't decode here.
        <div className="takes-preview-novideo">
          {poster && <img className="takes-preview-poster" src={poster} alt="" />}
          <p>Para ver la vista previa hay que generar el proxy de reproducción (el crudo 4K no se decodifica acá).</p>
          <button className="primary" onClick={() => void optimizePlayback()}>
            Optimizar reproducción
          </button>
          <p style={{ opacity: 0.7, fontSize: 12 }}>Igual podés ajustar los tiempos con los campos y el timeline.</p>
        </div>
      ) : (
        <div className="takes-preview-novideo">
          {mediaError
            ? 'No se pudo cargar la vista previa. Podés ajustar los tiempos igual.'
            : 'No hay un ángulo de video para previsualizar. Podés ajustar los tiempos con los campos y el timeline.'}
        </div>
      )}

      <div className="takes-preview-transport">
        <button className="takes-preview-play" onClick={togglePlay} disabled={!mediaUrl || !isVideo || mediaError} title={playing ? 'Pausar' : 'Reproducir'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="takes-preview-clock">
          {mmss(currentMs)} / {mmss(winEnd)}
        </span>
        <button className="takes-preview-mute" onClick={() => setMuted((m) => !m)} disabled={!mediaUrl || !isVideo || mediaError} title={muted ? 'Activar sonido' : 'Silenciar'}>
          {muted ? '🔇' : '🔊'}
        </button>
      </div>

      {/* Full-duration track. Click anywhere (or on a region) to seek; drag a handle to move a boundary. */}
      <div className="takes-preview-track" ref={trackRef} onPointerDown={(e) => seekToClientX(e.clientX)}>
        {durationMs > winStart && durationMs < winEnd && (
          <div className="takes-preview-speechend" style={{ left: `${msToPct(durationMs)}%` }} title="Fin del habla detectada" />
        )}

        {takes.map((take, ti) => {
          const left = msToPct(take.startMs)
          const width = Math.max(0, msToPct(take.endMs) - left)
          const accepted = plan.takeAccepted[ti]
          const isSel = ti === selectedIdx
          const span = Math.max(1, take.endMs - take.startMs)
          const cls = `takes-preview-region${isSel ? ' selected' : ''}${accepted ? '' : ' rejected'}`
          const regionStyle: React.CSSProperties = { left: `${left}%`, width: `${width}%` }
          ;(regionStyle as Record<string, string>)['--region-col'] = regionColor(take, ti)
          return (
            <div
              key={take.index}
              className={cls}
              style={regionStyle}
              title={`Guión ${take.guionNumber ?? take.index}: ${take.title}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                setSelectedIdx(ti)
                seekToClientX(e.clientX)
              }}
            >
              <span className="takes-preview-region-label">{take.guionNumber ?? take.index}</span>
              {cutsFor(take.index).map(({ c: cut, gi }) => {
                const accepted = plan.cutAccepted[gi] ?? true
                const secs = ((cut.endMs - cut.startMs) / 1000).toFixed(1)
                return (
                  <div
                    key={gi}
                    className={`takes-preview-cut${accepted ? '' : ' rejected'}`}
                    style={{ left: `${clamp01((cut.startMs - take.startMs) / span) * 100}%`, width: `${clamp01((cut.endMs - cut.startMs) / span) * 100}%` }}
                    title={`${cut.reason || cut.kind} (${secs} s) — clic para ${accepted ? 'rechazar' : 'activar'}`}
                    data-tel="takes.cut_toggle_marker"
                    onPointerDown={(e) => {
                      e.stopPropagation() // don't seek/select the region when toggling a cut
                      setCutAccepted(gi, !plan.cutAccepted[gi])
                    }}
                  />
                )
              })}
              <div
                className="takes-preview-handle left"
                onPointerDown={(e) => onHandleDown(e, ti, 'start')}
                onPointerMove={(e) => onHandleMove(e, ti, 'start')}
                onPointerUp={(e) => onHandleUp(e, ti, 'start')}
              />
              <div
                className="takes-preview-handle right"
                onPointerDown={(e) => onHandleDown(e, ti, 'end')}
                onPointerMove={(e) => onHandleMove(e, ti, 'end')}
                onPointerUp={(e) => onHandleUp(e, ti, 'end')}
              />
            </div>
          )
        })}

        <div className="takes-preview-playhead" style={{ left: `${msToPct(currentMs)}%` }} />
      </div>

      {/* Fine controls for the selected region. Numeric entry gives frame-level precision regardless of
          track width (the drag handles are only for rough placement on long videos). */}
      {selected && (
        <div className="takes-preview-controls">
          <span className="takes-preview-controls-title" style={{ color: regionColor(selected, selectedIdx) }}>
            Guión {selected.guionNumber ?? selected.index}: {selected.title}
          </span>
          <div className="takes-preview-field">
            <label>Inicio</label>
            <input
              key={`start-${selectedIdx}-${selected.startMs}`}
              defaultValue={mmss(selected.startMs)}
              onBlur={(e) => {
                const ms = parseMmss(e.currentTarget.value)
                if (ms != null) setEdge(selectedIdx, 'start', ms, true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button onClick={() => nudge('start', -1)} title="−1 frame">−</button>
            <button onClick={() => nudge('start', 1)} title="+1 frame">+</button>
            <button onClick={() => setEdge(selectedIdx, 'start', currentMs, true)} title="Fijar inicio en la posición actual del video">
              Usar posición actual
            </button>
          </div>
          <div className="takes-preview-field">
            <label>Fin</label>
            <input
              key={`end-${selectedIdx}-${selected.endMs}`}
              defaultValue={mmss(selected.endMs)}
              onBlur={(e) => {
                const ms = parseMmss(e.currentTarget.value)
                if (ms != null) setEdge(selectedIdx, 'end', ms, true)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button onClick={() => nudge('end', -1)} title="−1 frame">−</button>
            <button onClick={() => nudge('end', 1)} title="+1 frame">+</button>
            <button onClick={() => setEdge(selectedIdx, 'end', currentMs, true)} title="Fijar fin en la posición actual del video">
              Usar posición actual
            </button>
          </div>
          <button className="takes-preview-playregion" onClick={playRegion} disabled={!mediaUrl || !isVideo || mediaError}>
            ▶ Reproducir región
          </button>
        </div>
      )}
    </div>
  )
}
