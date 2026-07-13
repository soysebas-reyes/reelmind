// SPDX-License-Identifier: GPL-3.0-or-later
// Serializes a Timeline to Final Cut Pro 7 interchange XML (`<xmeml version="5">`). This is the ONE
// format that imports reliably into Premiere Pro AND DaVinci Resolve AND Final Cut — Premiere's FCPXML
// importer is deprecated, but all three read legacy xmeml. It's also the cleanest target for our data:
// the timeline is integer frames at a single fps and xmeml is natively integer-frame, so start/end/in/out
// drop in with no rounding.
//
// Pure string builder (no IO): the orchestrator (main/interchange/handoff.ts) bakes the media, then hands
// us the resolved InterchangeSource list + a clip→source lookup. Our color grade and audio enhancement are
// already baked into the referenced media; here we lay out cuts, trims, opacity, crop, transform, volume
// and A/V links so the editor opens re-editable clips with our look already applied. Text/lottie clips and
// keyframe animation (incl. fades) are intentionally dropped (the editor adds titles/effects) — reported
// as warnings.

import type { BakeMode } from './bakePlan'
import { isVisual } from '../model/clipType'
import type { ClipType } from '../model/clipType'
import { trackIsActive } from '../model/keyframe'
import {
  type Clip,
  type Timeline,
  clipEndFrame,
  cropIsIdentity,
  sourceFramesConsumed,
  totalFrames
} from '../model/timeline'

export interface InterchangeSource {
  /** xmeml `<file id>` — one per distinct baked/referenced media. */
  fileId: string
  mediaRef: string
  /** BakeJob.bakeKey this source came from (used by the caller's clip→source lookup). */
  bakeKey: string
  name: string
  /** Absolute `file://` URL of the media on disk (baked file or original). Used by the xmeml writer. */
  fileUrl: string
  /** Absolute OS path of the media on disk (baked file or original). Used by the CapCut draft writer,
   *  which stores plain forward-slashed paths rather than `file://` URLs. Optional for back-compat. */
  filePath?: string
  /** File length in timeline frames. */
  durationFrames: number
  width: number
  height: number
  hasAudio: boolean
  mediaType: ClipType
  mode: BakeMode
  /** Source frame at baked frame 0 (0 when referencing the whole original). */
  bakedStartFrame: number
}

export interface BuildInterchangeInput {
  timeline: Timeline
  sequenceName: string
  sources: InterchangeSource[]
  /** Resolve a clip to the source file it should reference, or null to skip it (offline). */
  clipFile: (clip: Clip) => InterchangeSource | null
}

export interface BuildInterchangeResult {
  xml: string
  warnings: string[]
  clipItemCount: number
}

// --- Small pure helpers (exported for unit tests) ---

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Integer timebase + NTSC flag for an fps. Fractional rates (23.976/29.97/59.94) carry ntsc=TRUE. */
export function fpsToTimebase(fps: number): { timebase: number; ntsc: boolean } {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01
  if (near(fps, 23.976) || near(fps, 23.98)) return { timebase: 24, ntsc: true }
  if (near(fps, 29.97)) return { timebase: 30, ntsc: true }
  if (near(fps, 59.94)) return { timebase: 60, ntsc: true }
  for (const w of [24, 25, 30, 50, 60]) if (near(fps, w)) return { timebase: w, ntsc: false }
  return { timebase: Math.round(fps), ntsc: false }
}

function encSegment(seg: string): string {
  return encodeURIComponent(seg)
}

/** Windows/POSIX absolute path → RFC-8089 `file://` URL. Per-segment percent-encoded; drive + slashes kept. */
export function windowsPathToFileUrl(absPath: string): string {
  const norm = absPath.replace(/\\/g, '/')
  // UNC \\server\share\... → file://server/share/...
  if (norm.startsWith('//')) {
    const parts = norm.slice(2).split('/').filter((x) => x.length > 0)
    if (parts.length === 0) return 'file://'
    const [host, ...rest] = parts
    return `file://${host}/${rest.map(encSegment).join('/')}`
  }
  // Drive-absolute C:/... → file:///C:/...
  const drive = /^([A-Za-z]):\/(.*)$/.exec(norm)
  if (drive) {
    const rest = drive[2].split('/').map(encSegment).join('/')
    return `file:///${drive[1]}:/${rest}`
  }
  // POSIX absolute /a/b
  if (norm.startsWith('/')) {
    return `file:///${norm.slice(1).split('/').map(encSegment).join('/')}`
  }
  return `file://${norm.split('/').map(encSegment).join('/')}`
}

function transformIsDefault(c: Clip): boolean {
  const t = c.transform
  return t.centerX === 0.5 && t.centerY === 0.5 && t.width === 1 && t.height === 1 && t.rotation === 0
}

function clipInOut(clip: Clip, src: InterchangeSource): { inF: number; outF: number } {
  if (src.mode === 'source') {
    const inF = clip.trimStartFrame - src.bakedStartFrame
    return { inF, outF: inF + sourceFramesConsumed(clip) }
  }
  // clip / image: speed baked in (or a still) → the whole baked segment plays 1:1.
  return { inF: 0, outF: clip.durationFrames }
}

// --- Emitted item bookkeeping ---

interface Item {
  id: string
  clip: Clip
  src: InterchangeSource
  start: number
  end: number
  inF: number
  outF: number
  group: number
}
interface LinkMember {
  id: string
  mediatype: 'video' | 'audio'
  trackindex: number
  clipindex: number
}

function isInvisible(c: Clip): boolean {
  return c.opacity <= 0 && !trackIsActive(c.opacityTrack)
}

function hasDroppedAnimation(c: Clip): boolean {
  return (
    c.fadeInFrames > 0 ||
    c.fadeOutFrames > 0 ||
    trackIsActive(c.opacityTrack) ||
    trackIsActive(c.positionTrack) ||
    trackIsActive(c.scaleTrack) ||
    trackIsActive(c.rotationTrack) ||
    trackIsActive(c.cropTrack) ||
    trackIsActive(c.volumeTrack)
  )
}

export function buildFcp7Xml(input: BuildInterchangeInput): BuildInterchangeResult {
  const { timeline, sequenceName } = input
  const { timebase, ntsc } = fpsToTimebase(timeline.fps)
  const ntscStr = ntsc ? 'TRUE' : 'FALSE'
  const warnings: string[] = []

  let clipItemSeq = 0
  let group = 0
  const nextClipId = (): string => `clipitem-${++clipItemSeq}`

  const videoLanes: Item[][] = []
  const audioLanes: Item[][] = []
  let droppedText = 0
  let droppedLottie = 0
  let droppedAnim = 0
  let offline = 0

  // Video/image tracks bottom-to-top: xmeml's FIRST <track> is the bottom layer, but our track index 0 is
  // the foreground — so emit in reverse (mirrors the export graph's back-to-front compositing).
  for (let ti = timeline.tracks.length - 1; ti >= 0; ti--) {
    const t = timeline.tracks[ti]
    if (t.hidden || t.type === 'audio') continue
    const lane: Item[] = []
    const audioLane: Item[] = []
    const sorted = [...t.clips].sort((a, b) => a.startFrame - b.startFrame)
    for (const clip of sorted) {
      if (clip.mediaType === 'text') {
        droppedText++
        continue
      }
      if (clip.mediaType === 'lottie') {
        droppedLottie++
        continue
      }
      if (isInvisible(clip)) continue
      const src = input.clipFile(clip)
      if (!src) {
        offline++
        continue
      }
      if (hasDroppedAnimation(clip)) droppedAnim++
      const g = group++
      const { inF, outF } = clipInOut(clip, src)
      lane.push({ id: nextClipId(), clip, src, start: clip.startFrame, end: clipEndFrame(clip), inF, outF, group: g })
      if (src.hasAudio) {
        audioLane.push({
          id: nextClipId(),
          clip,
          src,
          start: clip.startFrame,
          end: clipEndFrame(clip),
          inF,
          outF,
          group: g
        })
      }
    }
    if (lane.length > 0) videoLanes.push(lane)
    if (audioLane.length > 0) audioLanes.push(audioLane)
  }

  // Audio-type tracks (in natural order); muted tracks are skipped.
  for (const t of timeline.tracks) {
    if (t.type !== 'audio' || t.hidden || t.muted) continue
    const lane: Item[] = []
    const sorted = [...t.clips].sort((a, b) => a.startFrame - b.startFrame)
    for (const clip of sorted) {
      const src = input.clipFile(clip)
      if (!src) {
        offline++
        continue
      }
      if (hasDroppedAnimation(clip)) droppedAnim++
      const g = group++
      const { inF, outF } = clipInOut(clip, src)
      lane.push({ id: nextClipId(), clip, src, start: clip.startFrame, end: clipEndFrame(clip), inF, outF, group: g })
    }
    if (lane.length > 0) audioLanes.push(lane)
  }

  // Group members (for A/V <link> blocks). trackindex/clipindex are 1-based within their media type.
  const members = new Map<number, LinkMember[]>()
  const pushMember = (g: number, m: LinkMember): void => {
    const arr = members.get(g)
    if (arr) arr.push(m)
    else members.set(g, [m])
  }
  videoLanes.forEach((lane, li) =>
    lane.forEach((it, ci) => pushMember(it.group, { id: it.id, mediatype: 'video', trackindex: li + 1, clipindex: ci + 1 }))
  )
  audioLanes.forEach((lane, li) =>
    lane.forEach((it, ci) => pushMember(it.group, { id: it.id, mediatype: 'audio', trackindex: li + 1, clipindex: ci + 1 }))
  )

  // --- Render ---
  const declared = new Set<string>()
  const rate = `<rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>`

  const fileEl = (src: InterchangeSource): string => {
    if (declared.has(src.fileId)) return `<file id="${xmlEscape(src.fileId)}"/>`
    declared.add(src.fileId)
    const audioMedia = src.hasAudio ? `<audio><channelcount>2</channelcount></audio>` : ''
    return [
      `<file id="${xmlEscape(src.fileId)}">`,
      `<name>${xmlEscape(src.name)}</name>`,
      `<pathurl>${xmlEscape(src.fileUrl)}</pathurl>`,
      rate,
      `<duration>${src.durationFrames}</duration>`,
      `<media><video><samplecharacteristics><width>${src.width}</width><height>${src.height}</height></samplecharacteristics></video>${audioMedia}</media>`,
      `</file>`
    ].join('')
  }

  const linksFor = (g: number): string => {
    const arr = members.get(g)
    if (!arr || arr.length < 2) return ''
    return arr
      .map(
        (m) =>
          `<link><linkclipref>${m.id}</linkclipref><mediatype>${m.mediatype}</mediatype><trackindex>${m.trackindex}</trackindex><clipindex>${m.clipindex}</clipindex></link>`
      )
      .join('')
  }

  const opacityFilter = (opacity: number): string =>
    `<filter><effect><name>Opacity</name><effectid>opacity</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><name>opacity</name><parameterid>opacity</parameterid><valuemin>0</valuemin><valuemax>100</valuemax><value>${round2(opacity * 100)}</value></parameter></effect></filter>`

  const cropFilter = (c: Clip): string => {
    const p = (id: string, name: string, v: number): string =>
      `<parameter><name>${name}</name><parameterid>${id}</parameterid><valuemin>0</valuemin><valuemax>100</valuemax><value>${round2(v * 100)}</value></parameter>`
    return `<filter><effect><name>Crop</name><effectid>crop</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>${p('left', 'left', c.crop.left)}${p('right', 'right', c.crop.right)}${p('top', 'top', c.crop.top)}${p('bottom', 'bottom', c.crop.bottom)}</effect></filter>`
  }

  const motionFilter = (c: Clip): string => {
    const scale = round2(c.transform.width * 100)
    const horiz = round4((c.transform.centerX - 0.5) * 2)
    const vert = round4((c.transform.centerY - 0.5) * 2)
    const rot = round2(c.transform.rotation)
    return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><name>Scale</name><parameterid>scale</parameterid><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale}</value></parameter><parameter><name>Center</name><parameterid>center</parameterid><value><horiz>${horiz}</horiz><vert>${vert}</vert></value></parameter><parameter><name>Rotation</name><parameterid>rotation</parameterid><valuemin>-100000</valuemin><valuemax>100000</valuemax><value>${rot}</value></parameter></effect></filter>`
  }

  const audioLevelFilter = (volume: number): string =>
    `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><name>Level</name><parameterid>level</parameterid><valuemin>0</valuemin><valuemax>3.98108</valuemax><value>${round4(volume)}</value></parameter></effect></filter>`

  const videoClipItem = (it: Item): string => {
    const c = it.clip
    const filters: string[] = []
    if (c.opacity < 1) filters.push(opacityFilter(c.opacity))
    if (!cropIsIdentity(c.crop)) filters.push(cropFilter(c))
    if (!transformIsDefault(c)) filters.push(motionFilter(c))
    return [
      `<clipitem id="${it.id}">`,
      `<name>${xmlEscape(it.src.name)}</name>`,
      `<enabled>TRUE</enabled>`,
      `<duration>${it.src.durationFrames}</duration>`,
      rate,
      `<start>${it.start}</start>`,
      `<end>${it.end}</end>`,
      `<in>${it.inF}</in>`,
      `<out>${it.outF}</out>`,
      fileEl(it.src),
      `<compositemode>normal</compositemode>`,
      filters.join(''),
      linksFor(it.group),
      `</clipitem>`
    ].join('')
  }

  const audioClipItem = (it: Item): string => {
    const c = it.clip
    const level = c.volume !== 1 ? audioLevelFilter(c.volume) : ''
    return [
      `<clipitem id="${it.id}">`,
      `<name>${xmlEscape(it.src.name)}</name>`,
      `<enabled>TRUE</enabled>`,
      `<duration>${it.src.durationFrames}</duration>`,
      rate,
      `<start>${it.start}</start>`,
      `<end>${it.end}</end>`,
      `<in>${it.inF}</in>`,
      `<out>${it.outF}</out>`,
      fileEl(it.src),
      `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>`,
      level,
      linksFor(it.group),
      `</clipitem>`
    ].join('')
  }

  const videoTracksXml = videoLanes.map((lane) => `<track>${lane.map(videoClipItem).join('')}</track>`).join('')
  const audioTracksXml = audioLanes.map((lane) => `<track>${lane.map(audioClipItem).join('')}</track>`).join('')
  const clipItemCount = videoLanes.reduce((n, l) => n + l.length, 0) + audioLanes.reduce((n, l) => n + l.length, 0)

  const dur = totalFrames(timeline)
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="5">`,
    `<sequence id="reelo-sequence">`,
    `<name>${xmlEscape(sequenceName)}</name>`,
    `<duration>${dur}</duration>`,
    rate,
    `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
    `<media>`,
    `<video>`,
    `<format><samplecharacteristics>${rate}<width>${timeline.width}</width><height>${timeline.height}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
    videoTracksXml,
    `</video>`,
    `<audio>`,
    `<format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>`,
    audioTracksXml,
    `</audio>`,
    `</media>`,
    `</sequence>`,
    `</xmeml>`
  ].join('\n')

  if (droppedText > 0) warnings.push(`${droppedText} clip(s) de texto omitidos — agregá los títulos/subtítulos en tu editor.`)
  if (droppedLottie > 0) warnings.push(`${droppedLottie} clip(s) Lottie omitidos (no se pueden hornear).`)
  if (offline > 0) warnings.push(`${offline} clip(s) sin media disponible fueron omitidos.`)
  if (droppedAnim > 0)
    warnings.push(`${droppedAnim} clip(s) tenían fades o keyframes que no se exportan (rehacelos en tu editor).`)

  return { xml, warnings, clipItemCount }
}

function round2(n: number): number {
  return Number(n.toFixed(2))
}
function round4(n: number): number {
  return Number(n.toFixed(4))
}
