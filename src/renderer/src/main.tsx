import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'
import { installMcpBridge } from './ai/mcpBridge'

installMcpBridge()

// OS drag-and-drop guard: a file dropped outside an explicit drop target must never navigate the
// window (Chromium's default). Targets that DO accept files call preventDefault in their own
// handlers before this bubbles.
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
