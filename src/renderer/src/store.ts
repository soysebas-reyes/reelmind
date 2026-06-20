// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer-side live editing state (Zustand + Immer). Main owns persistence; this owns the session.

import {
  type MediaManifest,
  type Timeline,
  expectedPath,
  makeManifest,
  makeTimeline,
  totalFrames
} from '@core'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { PROJECT_SCHEMA_VERSION, type FfmpegStatus } from '../../shared/ipc'

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function projectNameFromPath(p: string): string {
  return baseName(p).replace(/\.vproj$/i, '')
}

export interface EditorState {
  projectDir: string | null
  projectName: string
  createdAt: string
  timeline: Timeline
  manifest: MediaManifest
  /** Session-only base64 thumbnails keyed by asset id (regenerated on open). */
  thumbnails: Record<string, string | null>
  ffmpeg: FfmpegStatus | null
  busy: string | null
  dirty: boolean
  lastError: string | null

  init: () => Promise<void>
  newProject: () => void
  importFiles: () => Promise<void>
  saveProject: () => Promise<void>
  openProject: () => Promise<void>
  setResolution: (width: number, height: number) => void
  setFps: (fps: number) => void
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    projectDir: null,
    projectName: 'Untitled Project',
    createdAt: new Date().toISOString(),
    timeline: makeTimeline(),
    manifest: makeManifest(),
    thumbnails: {},
    ffmpeg: null,
    busy: null,
    dirty: false,
    lastError: null,

    init: async () => {
      const ffmpeg = await window.editorBridge.checkFfmpeg()
      set((s) => {
        s.ffmpeg = ffmpeg
      })
    },

    newProject: () => {
      set((s) => {
        s.projectDir = null
        s.projectName = 'Untitled Project'
        s.createdAt = new Date().toISOString()
        s.timeline = makeTimeline()
        s.manifest = makeManifest()
        s.thumbnails = {}
        s.dirty = false
        s.lastError = null
      })
    },

    importFiles: async () => {
      const paths = await window.editorBridge.pickMediaFiles()
      if (paths.length === 0) return
      set((s) => {
        s.busy = `Importing ${paths.length} file${paths.length === 1 ? '' : 's'}…`
        s.lastError = null
      })
      try {
        const imported = await window.editorBridge.importMedia(paths)
        set((s) => {
          for (const { entry, thumbnail } of imported) {
            s.manifest.entries.push(entry)
            s.thumbnails[entry.id] = thumbnail
          }
          if (imported.length > 0) s.dirty = true
        })
      } catch (e) {
        set((s) => {
          s.lastError = e instanceof Error ? e.message : String(e)
        })
      } finally {
        set((s) => {
          s.busy = null
        })
      }
    },

    saveProject: async () => {
      let dir = get().projectDir
      if (!dir) {
        const picked = await window.editorBridge.pickSaveProjectPath(get().projectName)
        if (!picked) return
        dir = picked
        set((s) => {
          s.projectDir = picked
          s.projectName = projectNameFromPath(picked)
        })
      }
      set((s) => {
        s.busy = 'Saving…'
      })
      const { projectName, createdAt, timeline, manifest } = get()
      const res = await window.editorBridge.saveProject(dir, {
        meta: { schemaVersion: PROJECT_SCHEMA_VERSION, name: projectName, createdAt, modifiedAt: new Date().toISOString() },
        timeline,
        manifest
      })
      set((s) => {
        s.busy = null
        if (res.ok) s.dirty = false
        else s.lastError = res.error ?? 'Save failed'
      })
    },

    openProject: async () => {
      const dir = await window.editorBridge.pickOpenProjectDir()
      if (!dir) return
      set((s) => {
        s.busy = 'Opening…'
        s.lastError = null
      })
      try {
        const data = await window.editorBridge.loadProject(dir)
        set((s) => {
          s.projectDir = dir
          s.projectName = data.meta.name || projectNameFromPath(dir)
          s.createdAt = data.meta.createdAt
          s.timeline = data.timeline
          s.manifest = data.manifest
          s.thumbnails = {}
          s.dirty = false
        })
        // Regenerate session thumbnails for restored assets.
        const items = data.manifest.entries
          .map((e) => {
            const path = expectedPath(data.manifest, e.id, dir)
            return path ? { id: e.id, path, type: e.type, durationSeconds: e.duration } : null
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
        if (items.length > 0) {
          const thumbs = await window.editorBridge.loadThumbnails(items)
          set((s) => {
            for (const t of thumbs) s.thumbnails[t.id] = t.thumbnail
          })
        }
      } catch (e) {
        set((s) => {
          s.lastError = e instanceof Error ? e.message : String(e)
        })
      } finally {
        set((s) => {
          s.busy = null
        })
      }
    },

    setResolution: (width, height) => {
      set((s) => {
        s.timeline.width = width
        s.timeline.height = height
        s.timeline.settingsConfigured = true
        s.dirty = true
      })
    },

    setFps: (fps) => {
      set((s) => {
        s.timeline.fps = fps
        s.timeline.settingsConfigured = true
        s.dirty = true
      })
    }
  }))
)

export function timelineTotalFrames(timeline: Timeline): number {
  return totalFrames(timeline)
}
