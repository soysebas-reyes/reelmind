import { contextBridge, ipcRenderer } from 'electron'

/**
 * The narrow, typed bridge exposed to the renderer. Per the architecture, the
 * renderer never gets `require`/`ipcRenderer` directly — only this surface.
 * It will grow (probeMedia, exportTimeline, saveProject, ...) in later phases.
 */
const editorBridge = {
  ping: (): Promise<{
    ok: boolean
    versions: { electron: string; chrome: string; node: string }
  }> => ipcRenderer.invoke('app:ping')
}

export type EditorBridge = typeof editorBridge

contextBridge.exposeInMainWorld('editorBridge', editorBridge)
