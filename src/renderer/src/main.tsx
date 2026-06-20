import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './App.css'
import { installMcpBridge } from './ai/mcpBridge'

installMcpBridge()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
