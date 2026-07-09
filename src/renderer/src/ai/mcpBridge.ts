// SPDX-License-Identifier: GPL-3.0-or-later
// Answers MCP tool-execution requests forwarded from the main-process MCP server by running them
// through the same executeTool path as the in-app agent — against the live EditorController.

import { runEditorTool } from './runTool'

export function installMcpBridge(): void {
  window.editorBridge.onMcpExecute(({ requestId, name, input }) => {
    void runEditorTool(name, input, 'mcp').then((result) => window.editorBridge.sendMcpResult(requestId, result))
  })
}
