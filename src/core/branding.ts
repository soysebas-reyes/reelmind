// SPDX-License-Identifier: GPL-3.0-or-later
// Single source of truth for the app's brand-bearing identifiers. Anything that embeds the product
// name in a runtime contract (protocol scheme, drag MIME type, storage keys) lives here so a rename
// is one edit instead of a hunt across main + renderer. The CSP in src/renderer/index.html is static
// HTML and cannot import this module — branding.test.ts keeps it in lockstep with MEDIA_SCHEME.

export const APP_NAME = 'Reelo'

/** Privileged custom scheme that streams local media to the renderer (see src/main/media/mediaProtocol.ts). */
export const MEDIA_SCHEME = 'reelo-media'

/** DataTransfer type for dragging a media-bin asset onto the timeline. */
export const ASSET_DRAG_MIME = 'application/x-reelo-asset'

/** localStorage key for the renderer's persisted panel layout. */
export const LAYOUT_STORAGE_KEY = 'reelo.layout'

/** Build a renderer-usable URL for an absolute local file path, served by the media protocol. */
export function mediaUrlForPath(absolutePath: string): string {
  return `${MEDIA_SCHEME}://local/${encodeURIComponent(absolutePath)}`
}
