// SPDX-License-Identifier: GPL-3.0-or-later
// Answers MCP tool-execution requests forwarded from the main-process MCP server by running them
// through the same executeTool path as the in-app agent — against the live EditorController.

import { executeTool } from '@core'
import { getController } from '../store'

export function installMcpBridge(): void {
  window.editorBridge.onMcpExecute(({ requestId, name, input }) => {
    const result = executeTool(getController(), name, input)
    window.editorBridge.sendMcpResult(requestId, result)
  })
}
