// SPDX-License-Identifier: GPL-3.0-or-later
// Ported from palmier-pro Sources/PalmierPro/Models/ClipType.swift (GPL-3.0, © Palmier, Inc.)

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'lottie'

export const CLIP_TYPES: readonly ClipType[] = ['video', 'audio', 'image', 'text', 'lottie']

export function trackLabel(type: ClipType): string {
  switch (type) {
    case 'video':
      return 'Video'
    case 'audio':
      return 'Audio'
    case 'image':
      return 'Image'
    case 'text':
      return 'Text'
    case 'lottie':
      return 'Lottie'
  }
}

export function isVisual(type: ClipType): boolean {
  return type === 'video' || type === 'image' || type === 'text' || type === 'lottie'
}

export function isCompatible(a: ClipType, b: ClipType): boolean {
  return a === b || (isVisual(a) && isVisual(b))
}

/** Classify a file by its (lowercased, no-dot) extension. Returns null if unsupported. */
export function clipTypeForExtension(ext: string): ClipType | null {
  switch (ext.toLowerCase()) {
    case 'mov':
    case 'mp4':
    case 'm4v':
      return 'video'
    case 'mp3':
    case 'wav':
    case 'aac':
    case 'm4a':
      return 'audio'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'tiff':
    case 'heic':
    case 'webp':
      return 'image'
    case 'json':
    case 'lottie':
      return 'lottie'
    default:
      return null
  }
}
