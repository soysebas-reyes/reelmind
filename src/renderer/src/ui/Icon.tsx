// SPDX-License-Identifier: GPL-3.0-or-later
// Monoline icon set in the spirit of SF Symbols: one consistent 24-grid, 1.6px
// stroke, round caps/joins, `currentColor` so icons inherit text color and adapt
// to hover/disabled/accent states. Replaces the emoji glyphs across the UI for a
// coherent, scalable symbol language (Apple HIG: consistent iconography).

import type { CSSProperties } from 'react'

export type IconName =
  | 'sync'
  | 'cut'
  | 'wand'
  | 'angles'
  | 'trash'
  | 'waveform'
  | 'bolt'
  | 'plus'
  | 'folder'
  | 'save'
  | 'export'
  | 'play'
  | 'pause'
  | 'close'
  | 'video'
  | 'music'
  | 'image'
  | 'text'
  | 'sparkles'
  | 'sound'
  | 'mute'
  | 'swap'
  | 'download'
  | 'gear'

/** Each entry is the inner SVG. Stroke icons inherit the wrapper's stroke; filled
 *  glyphs (play/pause) set their own fill and clear the stroke. */
const PATHS: Record<IconName, React.JSX.Element> = {
  sync: (
    <>
      <path d="M3 9a9 9 0 0 1 15-3.6L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 15a9 9 0 0 1-15 3.6L3 16" />
      <path d="M3 21v-5h5" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6" r="2.6" />
      <circle cx="6" cy="18" r="2.6" />
      <line x1="20" y1="4" x2="8.5" y2="15.5" />
      <line x1="14.5" y1="14.5" x2="20" y2="20" />
      <line x1="8.5" y1="8.5" x2="12" y2="12" />
    </>
  ),
  wand: (
    <>
      <path d="m3 21 12-12" />
      <path d="M15 4V2M15 16v-2M9 9H7M23 9h-2" />
      <path d="m18.4 6.6 1.1-1.1M18.4 11.4l1.1 1.1" />
      <path d="M17 8.5 19 9l-2 .5-.5 2-.5-2L14 9l2-.5.5-2z" fill="currentColor" stroke="none" />
    </>
  ),
  angles: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  ),
  waveform: (
    <>
      <line x1="4" y1="10" x2="4" y2="14" />
      <line x1="8" y1="6" x2="8" y2="18" />
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="16" y1="8" x2="16" y2="16" />
      <line x1="20" y1="11" x2="20" y2="13" />
    </>
  ),
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  folder: <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" />,
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </>
  ),
  export: (
    <>
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="8 7 12 3 16 7" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.87l12-7.5a1 1 0 0 0 0-1.74l-12-7.5A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  close: (
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>
  ),
  video: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2.5" />
      <path d="m10 9.2 5 2.8-5 2.8z" fill="currentColor" stroke="none" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <circle cx="8.5" cy="8.5" r="1.8" />
      <path d="m21 15-4.5-4.5L5 21" />
    </>
  ),
  text: (
    <>
      <polyline points="5 7 5 5 19 5 19 7" />
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="9.5" y1="19" x2="14.5" y2="19" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3.5 13.7 8 18 9.7 13.7 11.4 12 16l-1.7-4.6L6 9.7 10.3 8z" />
      <path d="M19 14.5 19.8 16.5 21.8 17.3 19.8 18.1 19 20.1 18.2 18.1 16.2 17.3 18.2 16.5z" fill="currentColor" stroke="none" />
    </>
  ),
  sound: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  mute: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </>
  ),
  swap: (
    <>
      <polyline points="17 4 21 8 17 12" />
      <line x1="21" y1="8" x2="7" y2="8" />
      <polyline points="7 20 3 16 7 12" />
      <line x1="3" y1="16" x2="17" y2="16" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01A1.7 1.7 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01A1.7 1.7 0 0 0 20.91 10H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z" />
    </>
  )
}

export function Icon({
  name,
  size = 18,
  strokeWidth = 1.6,
  className,
  style
}: {
  name: IconName
  size?: number
  strokeWidth?: number
  className?: string
  style?: CSSProperties
}): React.JSX.Element {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      {PATHS[name]}
    </svg>
  )
}

export default Icon
