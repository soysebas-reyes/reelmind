// SPDX-License-Identifier: GPL-3.0-or-later
// Renderer-side live editing state. The EditorController (in @core) is the single source of
// truth for the timeline + undo/redo; this store mirrors its snapshot for React rendering and
// owns the things the controller doesn't: project IO, the media bin, and FFmpeg status.
//
// Editing commands are issued through `getController()` (UI, and later the in-app agent + MCP
// server, all call the same commands). The subscription below pushes every change back here.

import {
  Defaults,
  EditorController,
  type EditorChangeKind,
  type MediaManifest,
  type MediaManifestEntry,
  type Timeline,
  expectedPath,
  makeManifest,
  makeTimeline,
  totalFrames
} from '@core'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { PROJECT_SCHEMA_VERSION, type FfmpegStatus, type ImportedAsset } from '../../shared/ipc'

const controller = new EditorController()

/** The shared editing brain. UI components call commands on this directly. */
export function getController(): EditorController {
  return controller
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function projectNameFromPath(p: string): string {
  return baseName(p).replace(/\.vproj$/i, '')
}

/** Full-length clip duration (frames) for a freshly dropped asset at the project fps. */
export function defaultClipFramesForAsset(entry: MediaManifestEntry, fps: number): number {
  switch (entry.type) {
    case 'video':
    case 'audio':
    case 'lottie':
      return Math.max(1, Math.round((entry.duration || Defaults.imageDurationSeconds) * fps))
    case 'image':
      return Math.max(1, Math.round(Defaults.imageDurationSeconds * fps))
    case 'text':
      return Math.max(1, Math.round(Defaults.textDurationSeconds * fps))
  }
}

export interface EditorState {
  // Mirrored from the controller (read-only for components).
  timeline: Timeline
  currentFrame: number
  selectedClipIds: string[]
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null

  // Owned here.
  projectDir: string | null
  projectName: string
  createdAt: string
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
  importFromSources: (sources: string[]) => Promise<ImportedAsset[]>
  saveProject: () => Promise<void>
  openProject: () => Promise<void>
  exportProject: () => Promise<void>
  setResolution: (width: number, height: number) => void
  setFps: (fps: number) => void
}

export const useEditorStore = create<EditorState>()(
  immer((set, get) => ({
    timeline: controller.getTimeline(),
    currentFrame: 0,
    selectedClipIds: [],
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,

    projectDir: null,
    projectName: 'Untitled Project',
    createdAt: new Date().toISOString(),
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
      controller.reset(makeTimeline())
      set((s) => {
        s.projectDir = null
        s.projectName = 'Untitled Project'
        s.createdAt = new Date().toISOString()
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

    // Import from explicit paths/URLs (used by the AI tools / MCP, e.g. a generated clip).
    importFromSources: async (sources) => {
      const imported = await window.editorBridge.importSources(sources)
      set((s) => {
        for (const { entry, thumbnail } of imported) {
          s.manifest.entries.push(entry)
          s.thumbnails[entry.id] = thumbnail
        }
        if (imported.length > 0) s.dirty = true
      })
      return imported
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
      const { projectName, createdAt, manifest } = get()
      const res = await window.editorBridge.saveProject(dir, {
        meta: { schemaVersion: PROJECT_SCHEMA_VERSION, name: projectName, createdAt, modifiedAt: new Date().toISOString() },
        timeline: controller.getTimeline(),
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
        controller.load(data.timeline)
        set((s) => {
          s.projectDir = dir
          s.projectName = data.meta.name || projectNameFromPath(dir)
          s.createdAt = data.meta.createdAt
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

    exportProject: async () => {
      const out = await window.editorBridge.pickExportPath(get().projectName)
      if (!out) return
      set((s) => {
        s.busy = 'Exporting…'
        s.lastError = null
      })
      const res = await window.editorBridge.exportTimeline({
        timeline: controller.getTimeline(),
        manifest: get().manifest,
        projectDir: get().projectDir,
        outputPath: out
      })
      set((s) => {
        s.busy = null
        if (!res.ok) s.lastError = res.error ?? 'Export failed'
      })
    },

    setResolution: (width, height) => controller.setResolution(width, height),
    setFps: (fps) => controller.setFps(fps)
  }))
)

// Push every controller change into the store so React re-renders. `edit` marks the project
// dirty (for autosave); `view` (playhead/selection) and `load` (open/new) do not.
function syncFromController(kind: EditorChangeKind): void {
  const snap = controller.snapshot()
  useEditorStore.setState((s) => {
    s.timeline = snap.timeline
    s.currentFrame = snap.currentFrame
    s.selectedClipIds = snap.selectedClipIds
    s.canUndo = snap.canUndo
    s.canRedo = snap.canRedo
    s.undoLabel = snap.undoLabel
    s.redoLabel = snap.redoLabel
    if (kind === 'edit') s.dirty = true
  })
}
controller.subscribe(syncFromController)

export function timelineTotalFrames(timeline: Timeline): number {
  return totalFrames(timeline)
}
