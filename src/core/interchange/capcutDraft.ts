// SPDX-License-Identifier: GPL-3.0-or-later
// Serializes a Timeline to a CapCut / CapCut-desktop "draft" (剪映/JianYing lineage): the two JSON files
// CapCut reads from a draft folder — `draft_content.json` (the timeline: materials + tracks + segments)
// and `draft_meta_info.json` (the draft registry entry: name, id, media list). Format reverse-engineered
// from real CapCut drafts (same schema the open-source pyJianYingDraft / CapCutAPI generators target):
// integer MICROSECOND time-ranges, one `material` per distinct media, one `segment` per placed clip, and
// per-segment `speed` / `canvas` / `sound_channel_mapping` helper materials referenced by id.
//
// Pure (no IO, no clock, no crypto): the orchestrator (main/interchange/handoff.ts) bakes the media, hands
// us the resolved InterchangeSource list + a clip→source lookup + a UUID factory + a `now` timestamp, and
// writes what we return. Our color grade + audio enhancement are already baked into the referenced media,
// so CapCut opens re-editable segments with our look in the pixels/audio. Like the xmeml handoff we DROP
// text/lottie clips, keyframe animation (incl. fades) and non-identity crop — reported as warnings; the
// editor re-adds titles/effects/crop.
//
// CapCut is simpler than xmeml for audio: a video segment plays its own embedded audio (has_audio +
// segment volume), so we do NOT emit a separate linked audio segment for a video clip's own track.

import { trackIsActive } from '../model/keyframe'
import {
  type Clip,
  type Timeline,
  cropIsIdentity,
  sourceFramesConsumed,
  totalFrames
} from '../model/timeline'
import type { InterchangeSource } from './fcp7xml'

// CapCut app/format version stamps. These are cosmetic-ish (they drive the "made with" banner and the
// migration path CapCut runs on open); real drafts carry a concrete version. Conservative recent values —
// if a CapCut build refuses the draft, bump these to match a draft it wrote itself (see README/plan).
const DRAFT_VERSION = 360000
const NEW_VERSION = '110.0.0'
const APP_VERSION = '5.9.0'

/** A placeholder image material is stretchable to any duration; CapCut uses a large sentinel (~3h). */
const IMAGE_MATERIAL_DURATION_US = 10_800_000_000

export interface BuildCapCutInput {
  timeline: Timeline
  draftName: string
  /** Absolute path of the draft folder on disk (CapCut stores it back verbatim). Forward-slashed by us. */
  draftFolderPath: string
  /** Absolute path of the CapCut draft ROOT (the folder that contains all draft folders). */
  draftRootPath: string
  sources: InterchangeSource[]
  /** Resolve a clip to the source file it should reference, or null to skip it (offline). */
  clipFile: (clip: Clip) => InterchangeSource | null
  /** Unique-id factory (inject `newId` in the app, a deterministic counter in tests). */
  newId: () => string
  /** Milliseconds since epoch (inject `Date.now()` in the app; a fixed value in tests). */
  nowMs: number
}

export interface BuildCapCutResult {
  /** Parsed object for `draft_content.json`. */
  content: Record<string, unknown>
  /** Parsed object for `draft_meta_info.json`. */
  meta: Record<string, unknown>
  warnings: string[]
  segmentCount: number
}

// --- Small pure helpers (exported for unit tests) ---

/** Timeline frame → integer microseconds at this fps. CapCut's native time unit. */
export function framesToUs(frames: number, fps: number): number {
  return Math.round((frames / fps) * 1_000_000)
}

/** Windows/POSIX path → forward-slashed absolute path (CapCut stores paths with `/` on every platform). */
export function toCapCutPath(absPath: string): string {
  return absPath.replace(/\\/g, '/')
}

function transformIsDefault(c: Clip): boolean {
  const t = c.transform
  return t.centerX === 0.5 && t.centerY === 0.5 && t.width === 1 && t.height === 1 && t.rotation === 0
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

/** Source window (in frames) this clip consumes from its baked/referenced file (mirrors fcp7xml.clipInOut). */
function clipInOutFrames(clip: Clip, src: InterchangeSource): { inF: number; durF: number } {
  if (src.mode === 'source') {
    const inF = clip.trimStartFrame - src.bakedStartFrame
    return { inF, durF: sourceFramesConsumed(clip) }
  }
  // clip / image: speed baked in (or a still) → the whole baked segment plays 1:1.
  return { inF: 0, durF: clip.durationFrames }
}

const PLATFORM = (): Record<string, unknown> => ({
  app_id: 3704,
  app_source: 'cc',
  app_version: APP_VERSION,
  device_id: '',
  hard_disk_id: '',
  mac_address: '',
  os: 'windows',
  os_version: ''
})

/** CapCut's default (identity) crop corners in normalized source space. */
function identityCrop(): Record<string, number> {
  return {
    lower_left_x: 0.0,
    lower_left_y: 1.0,
    lower_right_x: 1.0,
    lower_right_y: 1.0,
    upper_left_x: 0.0,
    upper_left_y: 0.0,
    upper_right_x: 1.0,
    upper_right_y: 0.0
  }
}

interface PlacedSegment {
  segment: Record<string, unknown>
  materialId: string
}

export function buildCapCutDraft(input: BuildCapCutInput): BuildCapCutResult {
  const { timeline, draftName, sources, newId, nowMs } = input
  const fps = timeline.fps
  const warnings: string[] = []

  // 1) One material per distinct baked/referenced source (keyed by fileId — stable across clips).
  const materialIdByFileId = new Map<string, string>()
  const videoMaterials: Record<string, unknown>[] = []
  const audioMaterials: Record<string, unknown>[] = []

  const materialForSource = (src: InterchangeSource): string => {
    const existing = materialIdByFileId.get(src.fileId)
    if (existing) return existing
    const id = newId()
    materialIdByFileId.set(src.fileId, id)
    const path = toCapCutPath(src.filePath ?? '')
    if (src.mediaType === 'audio') {
      audioMaterials.push({
        id,
        type: 'extract_music',
        name: src.name,
        path,
        duration: framesToUs(src.durationFrames, fps),
        music_id: id,
        category_id: '',
        category_name: 'local',
        source_platform: 0,
        check_flag: 1
      })
    } else {
      const isPhoto = src.mediaType === 'image'
      videoMaterials.push({
        id,
        type: isPhoto ? 'photo' : 'video',
        material_name: src.name,
        path,
        duration: isPhoto ? IMAGE_MATERIAL_DURATION_US : framesToUs(src.durationFrames, fps),
        width: src.width,
        height: src.height,
        has_audio: src.hasAudio,
        crop: identityCrop(),
        crop_ratio: 'free',
        crop_scale: 1.0,
        category_id: '',
        category_name: 'local',
        check_flag: 63487,
        source_platform: 0,
        is_ai_generate_content: false,
        is_copyright: false,
        item_source: 1
      })
    }
    return id
  }

  // 2) Walk tracks → CapCut tracks of segments. Video/image tracks emit bottom-to-top so the last one is
  //    the foreground (render_index grows toward the front), mirroring the export graph's compositing.
  let droppedText = 0
  let droppedLottie = 0
  let droppedAnim = 0
  let droppedCrop = 0
  let offline = 0
  let renderIndex = 0
  let segmentCount = 0

  const speedMaterials: Record<string, unknown>[] = []
  const canvasMaterials: Record<string, unknown>[] = []
  const soundMappings: Record<string, unknown>[] = []
  const tracks: Record<string, unknown>[] = []

  /** Build the extra helper materials a segment references (speed always; canvas for video; sound map). */
  const makeExtras = (isVideoSeg: boolean): string[] => {
    const speedId = newId()
    speedMaterials.push({ id: speedId, type: 'speed', mode: 0, speed: 1.0, curve_speed: null })
    const soundId = newId()
    soundMappings.push({ id: soundId, type: 'none', audio_channel_mapping: 0, is_config_open: false })
    const refs = [speedId]
    if (isVideoSeg) {
      const canvasId = newId()
      canvasMaterials.push({ id: canvasId, type: 'canvas_color', color: '', blur: 0.0, image: '', album_image: '' })
      refs.push(canvasId)
    }
    refs.push(soundId)
    return refs
  }

  const buildVideoSegment = (clip: Clip, src: InterchangeSource): PlacedSegment => {
    const materialId = materialForSource(src)
    const { inF, durF } = clipInOutFrames(clip, src)
    if (!cropIsIdentity(clip.crop)) droppedCrop++
    if (hasDroppedAnimation(clip)) droppedAnim++
    const t = clip.transform
    const clipBlock = {
      alpha: clip.opacity,
      flip: { horizontal: false, vertical: false }, // flip is baked into the media
      rotation: transformIsDefault(clip) ? 0.0 : t.rotation,
      scale: { x: t.width, y: t.height },
      // CapCut normalizes position to [-1,1] of the canvas half-extent; +x right, +y UP.
      transform: { x: (t.centerX - 0.5) * 2, y: (0.5 - t.centerY) * 2 }
    }
    const segment = {
      id: newId(),
      material_id: materialId,
      target_timerange: { start: framesToUs(clip.startFrame, fps), duration: framesToUs(clip.durationFrames, fps) },
      source_timerange: { start: framesToUs(inF, fps), duration: framesToUs(durF, fps) },
      extra_material_refs: makeExtras(true),
      clip: clipBlock,
      uniform_scale: { on: true, value: 1.0 },
      speed: 1.0,
      volume: clip.volume,
      last_nonzero_volume: clip.volume > 0 ? clip.volume : 1.0,
      visible: true,
      cartoon: false,
      intensifies_audio: false,
      is_placeholder: false,
      is_tone_modify: false,
      reverse: false,
      enable_adjust: true,
      enable_color_curves: true,
      enable_color_wheels: true,
      enable_lut: true,
      common_keyframes: [],
      keyframe_refs: [],
      group_id: '',
      render_index: renderIndex,
      track_render_index: renderIndex,
      template_id: '',
      template_scene: 'default'
    }
    segmentCount++
    return { segment, materialId }
  }

  const buildAudioSegment = (clip: Clip, src: InterchangeSource): PlacedSegment => {
    const materialId = materialForSource(src)
    const { inF, durF } = clipInOutFrames(clip, src)
    if (hasDroppedAnimation(clip)) droppedAnim++
    const segment = {
      id: newId(),
      material_id: materialId,
      target_timerange: { start: framesToUs(clip.startFrame, fps), duration: framesToUs(clip.durationFrames, fps) },
      source_timerange: { start: framesToUs(inF, fps), duration: framesToUs(durF, fps) },
      extra_material_refs: makeExtras(false),
      speed: 1.0,
      volume: clip.volume,
      last_nonzero_volume: clip.volume > 0 ? clip.volume : 1.0,
      visible: true,
      intensifies_audio: false,
      is_placeholder: false,
      is_tone_modify: false,
      reverse: false,
      common_keyframes: [],
      keyframe_refs: [],
      group_id: '',
      render_index: renderIndex,
      track_render_index: renderIndex,
      template_id: '',
      template_scene: 'default'
    }
    segmentCount++
    return { segment, materialId }
  }

  // Video/image tracks, bottom (last index) to top (index 0).
  for (let ti = timeline.tracks.length - 1; ti >= 0; ti--) {
    const tr = timeline.tracks[ti]
    if (tr.hidden || tr.type === 'audio') continue
    const segs: Record<string, unknown>[] = []
    const sorted = [...tr.clips].sort((a, b) => a.startFrame - b.startFrame)
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
      segs.push(buildVideoSegment(clip, src).segment)
    }
    if (segs.length > 0) {
      tracks.push({ id: newId(), type: 'video', attribute: 0, flag: 0, is_default_name: true, name: '', segments: segs })
      renderIndex++
    }
  }

  // Audio tracks, natural order; muted tracks skipped (matches the xmeml handoff).
  for (const tr of timeline.tracks) {
    if (tr.type !== 'audio' || tr.hidden || tr.muted) continue
    const segs: Record<string, unknown>[] = []
    const sorted = [...tr.clips].sort((a, b) => a.startFrame - b.startFrame)
    for (const clip of sorted) {
      const src = input.clipFile(clip)
      if (!src) {
        offline++
        continue
      }
      segs.push(buildAudioSegment(clip, src).segment)
    }
    if (segs.length > 0) {
      tracks.push({ id: newId(), type: 'audio', attribute: 0, flag: 0, is_default_name: true, name: '', segments: segs })
      renderIndex++
    }
  }

  const durationUs = framesToUs(totalFrames(timeline), fps)

  // 3) draft_content.json — the full materials registry + tracks. Empty arrays are load-bearing (CapCut
  //    indexes them by key), so we spell out the whole shape rather than a sparse object.
  const content: Record<string, unknown> = {
    canvas_config: { width: timeline.width, height: timeline.height, ratio: 'original' },
    color_space: 0,
    config: {
      adjust_max_index: 1,
      attachment_info: [],
      combination_max_index: 1,
      export_range: null,
      extract_audio_last_index: 1,
      lyrics_recognition_id: '',
      lyrics_sync: true,
      lyrics_taskinfo: [],
      maintrack_adsorb: true,
      material_save_mode: 0,
      original_sound_last_index: 1,
      record_audio_last_index: 1,
      sticker_max_index: 1,
      subtitle_keywords_config: null,
      subtitle_recognition_id: '',
      subtitle_sync: true,
      subtitle_taskinfo: [],
      system_font_list: [],
      video_mute: false,
      zoom_info_params: null
    },
    cover: null,
    create_time: 0,
    duration: durationUs,
    extra_info: null,
    fps,
    free_render_index_mode_on: false,
    group_container: null,
    id: newId().toUpperCase(),
    keyframe_graph_list: [],
    keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
    last_modified_platform: PLATFORM(),
    materials: {
      audio_balances: [],
      audio_effects: [],
      audio_fades: [],
      audio_track_indexes: [],
      audios: audioMaterials,
      beats: [],
      canvases: canvasMaterials,
      chromas: [],
      color_curves: [],
      digital_humans: [],
      drafts: [],
      effects: [],
      flowers: [],
      green_screens: [],
      handwrites: [],
      hsl: [],
      images: [],
      log_color_wheels: [],
      loudnesses: [],
      manual_deformations: [],
      masks: [],
      material_animations: [],
      material_colors: [],
      multi_language_refs: [],
      placeholders: [],
      plugin_effects: [],
      primary_color_wheels: [],
      realtime_denoises: [],
      shapes: [],
      smart_crops: [],
      sound_channel_mappings: soundMappings,
      speeds: speedMaterials,
      stickers: [],
      tail_leaders: [],
      text_templates: [],
      texts: [],
      time_marks: [],
      transitions: [],
      video_effects: [],
      video_trackings: [],
      videos: videoMaterials,
      vocal_beautifys: [],
      vocal_separations: []
    },
    mutable_config: null,
    name: '',
    new_version: NEW_VERSION,
    platform: PLATFORM(),
    relationships: [],
    render_index_track_mode_on: false,
    retouch_cover: null,
    source: 'default',
    static_cover_image_path: '',
    time_marks: null,
    tracks,
    update_time: 0,
    version: DRAFT_VERSION
  }

  // 4) draft_meta_info.json — the registry entry CapCut lists in its "Drafts" grid.
  const nowUs = Math.round(nowMs * 1000)
  const nowS = Math.round(nowMs / 1000)
  const draftMediaValue = sources.map((src) => ({
    create_time: nowS,
    duration: src.mediaType === 'image' ? IMAGE_MATERIAL_DURATION_US : framesToUs(src.durationFrames, fps),
    extra_info: src.name,
    file_Path: toCapCutPath(src.filePath ?? ''),
    height: src.height,
    id: newId(),
    import_time: nowS,
    import_time_ms: nowUs,
    item_source: 1,
    md5: '',
    metetype: src.mediaType === 'image' ? 'photo' : src.mediaType === 'audio' ? 'music' : 'video',
    roughcut_time_range: { duration: -1, start: -1 },
    sub_time_range: { duration: -1, start: -1 },
    type: 0,
    width: src.width
  }))

  const meta: Record<string, unknown> = {
    cloud_package_completed_time: '',
    draft_cloud_capcut_purchase_info: '',
    draft_cloud_last_action_download: false,
    draft_cloud_materials: [],
    draft_cloud_purchase_info: '',
    draft_cloud_template_id: '',
    draft_cloud_tutorial_info: '',
    draft_cloud_videocut_purchase_info: '',
    draft_cover: '',
    draft_deeplink_url: '',
    draft_enterprise_info: { draft_enterprise_extra: '', draft_enterprise_id: '', draft_enterprise_name: '', enterprise_material: [] },
    draft_fold_path: toCapCutPath(input.draftFolderPath),
    draft_id: newId().toUpperCase(),
    draft_is_ai_packaging_used: false,
    draft_is_ai_shorts: false,
    draft_is_ai_translate: false,
    draft_is_article_video_draft: false,
    draft_is_from_deeplink: 'false',
    draft_is_invisible: false,
    draft_materials: [
      { type: 0, value: draftMediaValue },
      { type: 1, value: [] },
      { type: 2, value: [] },
      { type: 3, value: [] },
      { type: 6, value: [] },
      { type: 7, value: [] },
      { type: 8, value: [] }
    ],
    draft_materials_copied_info: [],
    draft_name: draftName,
    draft_new_version: '',
    draft_removable_storage_device: '',
    draft_root_path: toCapCutPath(input.draftRootPath),
    draft_segment_extra_info: [],
    draft_timeline_materials_size_: 0,
    draft_type: '',
    tm_draft_cloud_completed: '',
    tm_draft_cloud_modified: 0,
    tm_draft_create: nowUs,
    tm_draft_modified: nowUs,
    tm_duration: durationUs
  }

  if (droppedText > 0) warnings.push(`${droppedText} clip(s) de texto omitidos — agregá los títulos/subtítulos en CapCut.`)
  if (droppedLottie > 0) warnings.push(`${droppedLottie} clip(s) Lottie omitidos (no se pueden hornear).`)
  if (offline > 0) warnings.push(`${offline} clip(s) sin media disponible fueron omitidos.`)
  if (droppedAnim > 0)
    warnings.push(`${droppedAnim} clip(s) tenían fades o keyframes que no se exportan (rehacelos en CapCut).`)
  if (droppedCrop > 0)
    warnings.push(`${droppedCrop} clip(s) tenían recorte (crop) que CapCut no recibe — reaplicalo en CapCut.`)

  return { content, meta, warnings, segmentCount }
}
