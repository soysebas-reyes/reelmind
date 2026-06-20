import { contextBridge, ipcRenderer } from 'electron'
import type {
  ExportRequest,
  ExportResult,
  FfmpegStatus,
  ImportedAsset,
  ProjectData,
  SaveResult,
  ThumbnailRequest,
  ThumbnailResult
} from '../shared/ipc'

/**
 * The narrow, typed bridge exposed to the renderer. The renderer never gets
 * `require`/`ipcRenderer` directly — only this surface. Grows per phase.
 */
const editorBridge = {
  ping: (): Promise<{ ok: boolean; versions: { electron: string; chrome: string; node: string } }> =>
    ipcRenderer.invoke('app:ping'),

  checkFfmpeg: (): Promise<FfmpegStatus> => ipcRenderer.invoke('ffmpeg:check'),

  pickMediaFiles: (): Promise<string[]> => ipcRenderer.invoke('media:pick'),
  importMedia: (paths: string[]): Promise<ImportedAsset[]> => ipcRenderer.invoke('media:import', paths),
  loadThumbnails: (items: ThumbnailRequest[]): Promise<ThumbnailResult[]> =>
    ipcRenderer.invoke('media:thumbnails', items),

  pickSaveProjectPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('project:pickSavePath', defaultName),
  pickOpenProjectDir: (): Promise<string | null> => ipcRenderer.invoke('project:pickOpenDir'),
  saveProject: (dir: string, data: ProjectData): Promise<SaveResult> => ipcRenderer.invoke('project:save', dir, data),
  loadProject: (dir: string): Promise<ProjectData> => ipcRenderer.invoke('project:load', dir),

  pickExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('project:pickExportPath', defaultName),
  exportTimeline: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('project:export', req)
}

export type EditorBridge = typeof editorBridge

contextBridge.exposeInMainWorld('editorBridge', editorBridge)
