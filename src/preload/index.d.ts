import type { EditorBridge } from './index'

declare global {
  interface Window {
    editorBridge: EditorBridge
  }
}

export {}
