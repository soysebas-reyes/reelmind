import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AnalyzeTakesRequest,
  AnalyzeTakesResult,
  AudioOffsetRequest,
  AudioOffsetResult,
  AudioPreviewRequest,
  AudioPreviewResult,
  ColorLutData,
  ColorLutDataRequest,
  ColorStillRequest,
  DetectSilencesRequest,
  ExportRequest,
  ExportResult,
  EnhanceAudioRequest,
  EnhanceAudioResult,
  ExtractAudioRequest,
  ExtractAudioResult,
  FfmpegStatus,
  GenerateProxyRequest,
  GenerateProxyResult,
  ImportedAsset,
  IntensityAnalysisResult,
  IsolateVoiceRequest,
  IsolateVoiceResult,
  PreviewIsolateRequest,
  PreviewIsolateResult,
  OpProgressEvent,
  ProjectData,
  SaveResult,
  SilenceSeconds,
  ThumbnailRequest,
  ThumbnailResult,
  TranscribeRequest,
  TranscribeResult
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
  /** OS drag-and-drop: resolve a dropped File to its absolute path (sandbox-safe replacement for
   *  the removed File.path). Must run in the preload context. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  importMedia: (paths: string[]): Promise<ImportedAsset[]> => ipcRenderer.invoke('media:import', paths),
  importSources: (sources: string[]): Promise<ImportedAsset[]> => ipcRenderer.invoke('media:importSources', sources),
  loadThumbnails: (items: ThumbnailRequest[]): Promise<ThumbnailResult[]> =>
    ipcRenderer.invoke('media:thumbnails', items),

  pickSaveProjectPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('project:pickSavePath', defaultName),
  pickOpenProjectDir: (): Promise<string | null> => ipcRenderer.invoke('project:pickOpenDir'),
  saveProject: (dir: string, data: ProjectData): Promise<SaveResult> => ipcRenderer.invoke('project:save', dir, data),
  loadProject: (dir: string): Promise<ProjectData> => ipcRenderer.invoke('project:load', dir),

  pickExportPath: (defaultName: string): Promise<string | null> =>
    ipcRenderer.invoke('project:pickExportPath', defaultName),
  exportTimeline: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('project:export', req),
  /** Subscribe to export progress (0..1) for the current render. */
  onExportProgress: (cb: (fraction: number) => void): void => {
    ipcRenderer.on('export:progress', (_e, fraction: number) => cb(fraction))
  },
  /** Subscribe to generic backend op progress (stage label + raw log line) for long ops. */
  onOpProgress: (cb: (p: OpProgressEvent) => void): void => {
    ipcRenderer.on('op:progress', (_e, p: OpProgressEvent) => cb(p))
  },
  showItemInFolder: (filePath: string): Promise<void> => ipcRenderer.invoke('shell:showItem', filePath),
  detectSilences: (req: DetectSilencesRequest): Promise<SilenceSeconds[]> =>
    ipcRenderer.invoke('media:detectSilences', req),
  extractAudio: (req: ExtractAudioRequest): Promise<ExtractAudioResult> => ipcRenderer.invoke('media:extractAudio', req),
  computeAudioOffset: (req: AudioOffsetRequest): Promise<AudioOffsetResult> =>
    ipcRenderer.invoke('media:computeAudioOffset', req),
  analyzeIntensity: (path: string): Promise<IntensityAnalysisResult> =>
    ipcRenderer.invoke('media:analyzeIntensity', path),
  enhanceAudio: (req: EnhanceAudioRequest): Promise<EnhanceAudioResult> =>
    ipcRenderer.invoke('media:enhanceAudio', req),
  enhanceAudioPreview: (req: AudioPreviewRequest): Promise<AudioPreviewResult> =>
    ipcRenderer.invoke('media:enhanceAudioPreview', req),
  generateProxy: (req: GenerateProxyRequest): Promise<GenerateProxyResult> =>
    ipcRenderer.invoke('media:generateProxy', req),

  // Color (Phase 9.5)
  colorStill: (req: ColorStillRequest): Promise<string | null> => ipcRenderer.invoke('color:still', req),
  colorLutData: (req: ColorLutDataRequest): Promise<ColorLutData | null> => ipcRenderer.invoke('color:lutData', req),
  colorGetLutLibrary: (): Promise<string | null> => ipcRenderer.invoke('color:getLutLibrary'),
  colorSetLutLibrary: (): Promise<string | null> => ipcRenderer.invoke('color:setLutLibrary'),

  transcribeMedia: (req: TranscribeRequest): Promise<TranscribeResult> =>
    ipcRenderer.invoke('ai:transcribe', req),
  isolateVoice: (req: IsolateVoiceRequest): Promise<IsolateVoiceResult> =>
    ipcRenderer.invoke('ai:isolateVoice', req),
  previewIsolateVoice: (req: PreviewIsolateRequest): Promise<PreviewIsolateResult> =>
    ipcRenderer.invoke('ai:previewIsolateVoice', req),

  aiHasKey: (): Promise<boolean> => ipcRenderer.invoke('ai:hasKey'),
  aiSetKey: (key: string): Promise<void> => ipcRenderer.invoke('ai:setKey', key),
  aiClearKey: (): Promise<void> => ipcRenderer.invoke('ai:clearKey'),
  aiComplete: (req: AiCompleteRequest): Promise<AiCompleteResponse> => ipcRenderer.invoke('ai:complete', req),
  analyzeTakes: (req: AnalyzeTakesRequest): Promise<AnalyzeTakesResult> =>
    ipcRenderer.invoke('ai:analyzeTakes', req),

  // MCP tool execution requested by the main-process server, run against the renderer controller.
  onMcpExecute: (cb: (payload: { requestId: string; name: string; input: unknown }) => void): void => {
    ipcRenderer.on('mcp:execute', (_e, payload) => cb(payload))
  },
  sendMcpResult: (requestId: string, result: unknown): void =>
    ipcRenderer.send('mcp:execute:result', { requestId, result })
}

export type EditorBridge = typeof editorBridge

contextBridge.exposeInMainWorld('editorBridge', editorBridge)
