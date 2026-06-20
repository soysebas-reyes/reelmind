// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Tests/PalmierProTests/Fixtures.swift (GPL-3.0, © Palmier, Inc.)

import type { ClipType } from '../model/clipType'
import { type Clip, type Timeline, type Track, makeClip, makeTimeline, makeTrack } from '../model/timeline'

let counter = 0
function autoId(): string {
  counter += 1
  return `fixture-${counter}`
}

export function fxClip(args: {
  id?: string
  mediaRef?: string
  mediaType?: ClipType
  start: number
  duration: number
  trimStart?: number
  trimEnd?: number
  speed?: number
  volume?: number
}): Clip {
  const mediaType = args.mediaType ?? 'video'
  const c = makeClip({
    id: args.id ?? autoId(),
    mediaRef: args.mediaRef ?? 'media-1',
    mediaType,
    sourceClipType: mediaType,
    startFrame: args.start,
    durationFrames: args.duration,
    trimStartFrame: args.trimStart ?? 0,
    trimEndFrame: args.trimEnd ?? 0,
    speed: args.speed ?? 1.0,
    volume: args.volume ?? 1.0
  })
  return c
}

export function fxVideoTrack(args: { id?: string; clips?: Clip[] } = {}): Track {
  return makeTrack({ id: args.id ?? autoId(), type: 'video', clips: args.clips ?? [] })
}

export function fxAudioTrack(args: { id?: string; clips?: Clip[] } = {}): Track {
  return makeTrack({ id: args.id ?? autoId(), type: 'audio', clips: args.clips ?? [] })
}

export function fxTimeline(args: { fps?: number; tracks?: Track[] } = {}): Timeline {
  return makeTimeline({ fps: args.fps ?? 30, tracks: args.tracks ?? [] })
}
