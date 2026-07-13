# Reelo — Project Plan & State

> **For anyone (or any AI chat) picking this up fresh:** read [`../CLAUDE.md`](../CLAUDE.md) **first**
> (it states the non-negotiable measurement contract), then this file top to bottom, then
> [`ATTRIBUTION.md`](../ATTRIBUTION.md) and [`README.md`](../README.md). This is the single source
> of truth for what's built, why, and what comes next. **Toda feature nueva o cambio de UI DEBE
> instrumentarse en el sistema de medición** — ver [`TOTAL_MEASUREMENT_PLAN.md`](./TOTAL_MEASUREMENT_PLAN.md).

---

## 1. What this project is

**Reelo** is an open-source, **AI-native video editor for Windows**, built as an independent,
cross-platform derivative of **[palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro)**
(a native macOS/Swift app, GPL-3.0). We keep Reelo public, GPL-3.0, and credit Palmier.

- **Public repo:** https://github.com/soysebas-reyes/reelo
- **License:** GPL-3.0-or-later (preserves upstream `LICENSE` + `ATTRIBUTION.md`)

`palmier-pro` is ~99% Swift on Apple-only frameworks (AppKit/SwiftUI, AVFoundation, CoreML, Speech,
Sparkle). It cannot run on Windows, so this is **a rewrite, not a fork** — we re-implement the
*portable concepts* (timeline model, editing algorithms, the AI tool contract, the MCP design) and
rebuild the platform layers on cross-platform tech (Electron, FFmpeg, ONNX, whisper).

## 2. Decisions locked with the owner

1. **Independent public repo + attribution** (not a GitHub fork).
2. **Stack:** Electron + TypeScript + React (electron-vite, Vite 7, React 19, TS 6, vitest 3, Electron 42).
3. **Build order:** editor core first → AI/MCP layer → generation.
4. **Generation:** provider-agnostic adapter, **Higgs Field first**, then fal.ai/Replicate. AI is
   **bring-your-own-key (BYOK)** only — no Palmier Convex/Clerk/credits.

## 3. Architecture (target)

- **Electron 3-context model.** *Main* (Node): project IO, FFmpeg/ffprobe, secrets (Windows
  `safeStorage`/DPAPI), the embedded MCP server, the BYOK agent runner. *Preload*: a narrow,
  context-isolated, **sandboxed** bridge (CommonJS). *Renderer* (React): UI + live editing state +
  the pure engines (must run at 60fps).
- **`EditorController` command API** (Phase 2): every edit is one named, serializable, single-undo
  command. The UI, the in-app agent, and the MCP server all call the **same** commands.
- **Frame-based time** everywhere (integers), matching upstream.
- **Preview** = pooled `<video>` + Canvas compositor (real-time); **export** = one FFmpeg
  `filter_complex` (exact). Both share one geometry/opacity/volume module so they stay consistent.
- **AI** = one Zod tool contract + one executor, shared by two transports: in-app agent
  (`@anthropic-ai/sdk`, BYOK) and embedded MCP server (`@modelcontextprotocol/sdk`).
- **Generation** = `GenerationProvider` interface + `JobManager`; static `models.json` catalog.

### Build/tooling notes (gotchas)
- **No `"type": "module"`** in package.json — keeps main/preload as CommonJS so the sandboxed
  preload works and `__dirname` is available. The renderer is ESM via Vite regardless.
- **Dependency pin:** `electron-vite@5` only supports **Vite ≤7**, but `@vitejs/plugin-react@6`
  wants Vite 8. Pin `vite@^7`, `@vitejs/plugin-react@^5`, `vitest@^3`. Do NOT `--legacy-peer-deps`.
- IDs use `crypto.randomUUID()` (no nanoid — it's ESM-only and breaks the CJS main bundle).

## 4. Status

| Phase | Title | State |
|------|-------|-------|
| **P0** | Repo + scaffold | ✅ done |
| **P1** | Editor: media import + bin + project format | ✅ done |
| **P2** | Editor: timeline editing (drag/trim/split/ripple/snap, undo/redo) | ✅ done |
| **P3** | Editor: real-time multi-track preview | ✅ done (composite + real video playback) |
| **P4** | Editor: FFmpeg export | ✅ done (real render, integration-tested) |
| **P5** | AI: agent tool contract (Zod) + in-app chat (BYOK) | ✅ done |
| **P6** | AI: embedded MCP server (Claude Code / Cursor / Claude Desktop) | ✅ done (HTTP on localhost; integration-tested) |
| **P7** | Generation | ✅ via import — generate externally (Higgsfield) → import as media; provider SDK deferred |
| **P8** | Windows installer (electron-builder) | ✅ done — NSIS + bundled ffmpeg + GitHub auto-update; run `npm run dist` on a build machine |
| **P9** | Color: manual grading + look presets + `.cube` LUTs + AI control + reusable saved profiles | 📋 planned — see [`COLOR_GRADING_PLAN.md`](./COLOR_GRADING_PLAN.md) |
| **P9.5** | Color: Colorization Explorer — param panel, one-click recommended configs, save/compare *muestras* vs raw, "Elegir" one look for the whole video | ✅ done — headless core + UI + **live-playback WebGL LUT** (the earlier live-LUT gap was fixed in `9cfb32e`); export is exact |
| **P10** | Color: AI colorization (B&W → color) | 📋 planned (later) — see [`COLOR_GRADING_PLAN.md`](./COLOR_GRADING_PLAN.md) §2 |
| **P11** | Agentic copilot workflow: `import_folder` · `export` · `remove_silences` · recipes | 🚧 in progress — `import_folder` + `export` + `remove_silences` shipped; recipes pending; see [`AGENTIC_WORKFLOW_PLAN.md`](./AGENTIC_WORKFLOW_PLAN.md) |
| **P12** | CapCut parity — MCP tool surface + manual UX | ✅ core pass done (5 milestones, merged to `main`): widened `set_clip_properties` (text/transform/crop/audioEnhance) + `set_clips_properties`, `inspect_clip`, `list_assets`, `list/apply_color_preset`, `batch_operations` (1 IPC = 1 undo), keyframe tools, `ripple_delete_range`, `add_text_clip`, `get_frame_preview` (composited frame as a REAL image block in both transports), per-tool timeouts, `sync_angles` frames; UX: Space play/pause + `[`/`]`/Home/End/±zoom, Ctrl+C/X/V/D clipboard, right-click context menus (clip/track/empty), ClipInspector "Propiedades" tab (transform/opacity/speed/fades/volume, coalesced-undo sliders), multi-select group drag, OS drag-and-drop, inline fade handles, bigger transport + frame-step + preview rate. Pending (bigger core work): text rendering in preview-style + export (drawtext), transitions, keyframe curve UI, markers |
| **P13** | Multicam sync + audio enhancement + angle switching | ✅ done (merged to `main`): sync two angles by audio cross-correlation (no FFT); non-destructive per-clip voice-cleanup/loudness chain (Web Audio live + FFmpeg on export); non-destructive & ripple angle cuts with `linkGroupId` + track roles |
| **P14** | "Segmentar por guiones" (take detection) | ✅ done (merged to `main`): ElevenLabs Scribe transcript + `claude-sonnet-5` forced-tool aligns each pasted guión to its span → opens each take as a clean, editable tab (multi-session tabs, persisted in `sessions.json`); editable take-boundary preview. **Sync robusto**: el offset multicám se calcula con RMS **y** transcript reconciliados (`core/edit/syncOffset.ts` — un pico RMS confiable refuta un transcript que discrepa) y la segmentación **auto-sincroniza** 2 ángulos crudos antes de armar los tabs (+ `verifyLinkedAlignment` como red de seguridad por tab). Unit + integration green |
| **P15** | Editor-workflow handoff + MCP flow | ✅ done (merged to `main`, see §12): "Enviar a editor" → FCP7 xmeml **or a CapCut draft folder** + per-source **baked media** (grade + audio applied) for Premiere / DaVinci / Final Cut / **CapCut**; MCP workflow tools `segment_by_scripts` · `export_to_nle` (now incl. `target: 'capcut'`) · `new/open/save_project`; platform-URL import via `yt-dlp`. Unit + ffmpeg-integration green; **pending real-NLE + real-CapCut + on-device MCP E2E** |
| **P16** | Medición total — telemetría de **comportamiento** (nunca contenido) | ✅ P16.0 local hecho (ver §14): 3 capas de captura (física DOM · comandos vía `EditorController.run` · IO/IA vía `runEditorTool`) + core Zod (`src/core/telemetry/`) + sink **JSONL** en `userData` detrás de `TelemetrySink` + identidad `anonymousId`/`sessionId` + **guardrail** (`taxonomy.test.ts`) que rompe la build si un comando/tool nuevo no se registra. Arquitectura lista para **Supabase + cuentas**. Ver [`TOTAL_MEASUREMENT_PLAN.md`](./TOTAL_MEASUREMENT_PLAN.md). **Pending on-device E2E** (verificar JSONL + auditoría de redacción) |

**Verification bar (all green):** `npm run typecheck` (node + web), `npm run build` (main + preload + renderer),
`npm test` — **533 tests**, incl. EditorController command/undo, compositor, export-graph, AI-tool + agent-loop,
color/LUT, take-detection (transcript serialize / postprocess / script-align / take-plan), and the
**interchange** golden tests (fcp7xml / bakePlan / bakeCommand / **capcutDraft**); plus ffmpeg/MCP integration
suites — export render, media pipeline, the **NLE-handoff** end-to-end (bakes graded media + writes valid xmeml
**and a valid CapCut draft**), and a real MCP client↔server HTTP test — that self-skip if their deps are absent. The app boot-smoke-tests via
`npm run dev`: the AI panel + Anthropic SDK load in main, the media protocol serves video, and the MCP server
logs `listening at http://127.0.0.1:4399/mcp`.

> **Current state:** the editor is functionally complete and the AI/MCP layer works end-to-end — import
> (incl. URLs/yt-dlp), multi-track timeline editing, live preview, FFmpeg export, colorization, multicam sync,
> audio enhancement, angle switching, script-based take segmentation, and the NLE handoff. The in-app agent and
> the embedded MCP server both drive the *same* EditorController commands (BYOK Anthropic key, encrypted via
> safeStorage). Everything is merged to `main` (single branch, pushed). **P7 (generation) is descoped to
> import-based** — scenes are generated externally (e.g. Higgsfield) and imported, which the P1 pipeline handles.
> **Remaining:** real-world verification of take detection (on footage), the NLE handoff (in a real NLE) and
> the **CapCut draft** (in a real CapCut build) + the MCP flow with Claude Code; then shipping the packaged
> installer.

## 5. What exists today (file map)

```
src/
  core/                         # framework-free; runs in renderer, main, and tests
    constants.ts                # Defaults, Snap, VolumeScale, ProjectFiles, sround, newId
    model/
      clipType.ts               # ClipType + extension classification
      keyframe.ts               # Keyframe/KeyframeTrack, sampling, interpolation, AnimPair
      timeline.ts               # Clip/Track/Timeline + ALL clip-math (fade/opacity/volume/transform)
      manifest.ts               # MediaManifest/Entry, MediaSource, GenerationInput
      resolver.ts               # pure id → expected path
      *.test.ts                 # clipMath + keyframe golden tests
    engines/
      rippleEngine.ts           # computeRippleShifts / ForRanges / Push, mergeRanges
      overwriteEngine.ts        # computeOverwrite → remove/trimEnd/trimStart/split
      snapEngine.ts             # collectTargets + findSnap (sticky, playhead, probes)
      *.test.ts                 # engine golden tests (incl. adversarial)
    controller/
      EditorController.ts       # THE command API: add/move/trim/split/ripple/tracks/props;
                                #   Immer-patch undo/redo (1 command = 1 step); user/agent tags
      EditorController.test.ts  # 29 tests: engine parity, undo/redo round-trips, agent parity
    preview/compositor.ts       # composeFrame(timeline,frame) → ordered visual+audio layers (P3)
    export/exportGraph.ts       # buildExportGraph: timeline → one FFmpeg filter_complex (P4)
    export/colorFilters.ts      # ColorAdjustments → FFmpeg grade chain (shared by export + bake)
    interchange/                # NLE handoff (P15): pure + golden-tested
      fcp7xml.ts                #   Timeline → FCP7 xmeml (Premiere/Resolve/FCP), file:// encoding, A/V link
      capcutDraft.ts            #   Timeline → CapCut draft JSON (draft_content + draft_meta_info, µs timeranges)
      bakePlan.ts               #   plan one baked file per source (grade+audio); per-clip on speed
      bakeCommand.ts            #   ffmpeg args to bake a source (reuses buildColorFilterChain/EnhanceChain)
    ai/tools.ts                 # Zod tool contract + executeTool over EditorController (P5);
                                #   toJsonSchemaTools() for Anthropic/MCP; incl. segment_by_scripts,
                                #   export_to_nle, new/open/save_project (host-executed)
    testing/fixtures.ts         # fxClip / fxTrack / fxTimeline
    index.ts                    # barrel (import via "@core")
  shared/ipc.ts                 # wire types shared by main/preload/renderer
  main/
    index.ts                    # app lifecycle + window (sandbox, contextIsolation)
    ipc.ts                      # all ipcMain handlers (project:export, ai:complete, …)
    ai/{secrets,anthropic}.ts   # BYOK key (safeStorage/DPAPI) + Anthropic Messages proxy (P5)
    mcp/server.ts               # embedded Streamable-HTTP MCP server on localhost (P6)
    mcp/bridge.ts               # forwards MCP tools/call to the renderer controller over IPC
    mcp/server.test.ts          # real MCP client↔server HTTP integration test
    ffmpeg/ {binary,probe,thumbnail,index}.ts   # ffprobe/ffmpeg integration
    ffmpeg/exporter.ts          # runs buildExportGraph + spawns ffmpeg (P4)
    ffmpeg/exporter.test.ts     # renders a 3-track project end-to-end (self-skips if no ffmpeg)
    interchange/handoff.ts      # runHandoff: bake per-source media + write the xmeml package OR CapCut draft (P15)
    interchange/capcutLocate.ts #   detect CapCut's Windows draft root (auto-place the draft)
    interchange/handoff.test.ts # ffmpeg integration: bakes graded media + valid xmeml + valid CapCut draft (self-skips)
    media/importer.ts           # classify → probe → thumbnail → manifest entry
    media/importSources.ts      # import from paths / folders / URLs (+ yt-dlp for platform links)
    media/mediaProtocol.ts      # reelo-media:// — streams local files to the renderer (P3 video)
    media/mediaPipeline.test.ts # ffmpeg integration test (self-skips if no ffmpeg)
    ai/analyzeTakes.ts          # take detection: transcript → forced-tool claude-sonnet-5 (P14)
    project/projectStore.ts     # .vproj save/load (atomic writes; timeline/manifest/sessions)
    project/transcriptStore.ts  # persist ElevenLabs transcripts in cache/transcripts.json (P14)
  preload/index.ts(.d.ts)       # editorBridge (typed, sandboxed) — adds export methods
  renderer/
    index.html                  # CSP-locked shell
    src/{main.tsx,App.tsx,App.css}              # shell, bin + preview + timeline layout, topbar
    src/store.ts                # Zustand store mirrors the EditorController; project IO + export
    src/timeline/geometry.ts    # px↔frame layout math (ruler/tracks/clips)
    src/timeline/Timeline.tsx   # Canvas timeline: drag-from-bin, move+snap, trim, split, ripple
    src/preview/Preview.tsx     # composited preview canvas + transport (play/seek)
    src/takes/{TakesPlanModal,TakesPreview}.tsx, format.ts  # segment-by-scripts UI + editable preview (P14)
    src/tabs/SessionTabs.tsx    # multi-project / per-guión tab bar (P14)
    src/ai/{agent.ts,ChatPanel.tsx}  # in-app agent loop (executeTool) + BYOK chat UI (P5)
    src/ai/{runTool.ts,mcpBridge.ts} # host-tool routing + answers main's MCP tool-execute requests (P6)
scripts/fetch-ffmpeg.mjs        # downloads GPL win64 ffmpeg → resources/ffmpeg (build-time)
electron-builder.yml            # NSIS packaging: bundles ffmpeg + GitHub auto-update (P8)
resources/ffmpeg/               # bundled ffmpeg/ffprobe — GITIGNORED, fetched at build time
reference/palmier-pro/          # upstream clone — GITIGNORED, porting reference only
docs/PROJECT_PLAN.md            # this file
```

> **Important for a fresh clone:** `reference/` is gitignored, so a new checkout won't have the
> upstream source. To keep porting, re-clone it:
> `git clone --depth 1 https://github.com/palmier-io/palmier-pro reference/palmier-pro`

## 6. How to run (dev)

```powershell
npm install
npm run dev        # launches the Reelo window with hot reload
npm test           # 436 tests (ffmpeg/MCP integration suites self-skip without their deps)
npm run typecheck
npm run build      # production build into out/
npm run dist       # build a Windows installer (fetch ffmpeg → build → electron-builder) [build machine]
# To export: add clips to the timeline, then Export in the top bar (renders via FFmpeg).
```
Requirements: Node 20+ and **FFmpeg on PATH** (from P1 onward). Override binaries with env vars
`REELO_FFMPEG` / `REELO_FFPROBE` if needed.

## 7. Phase 2 — timeline editing ✅ done

Built the editing core + a canvas timeline; every mutation goes through one `EditorController` so the
AI agent (P5/P6) can later drive the same commands.

- **`src/core/controller/EditorController.ts`** — the command API over the timeline with an Immer-patch
  undo/redo stack. **One command = one undo step**; compound ops (overwrite = clear+insert, ripple-delete
  = remove+shift, split-inside-clear) collapse into a single step via `transact`. Transactions are tagged
  `user` vs `agent` (`runAs('agent', …)`). Commands: `addClip`/`overwriteClip`/`rippleInsertClip`,
  `clearRegion`, `moveClip(s)`, `trimClip`/`trimClipStart/End`, `trim*ToPlayhead`, `splitClip`/
  `splitAtPlayhead`, `removeClip(s)`, `rippleDelete` (refuses if a sync-locked follower can't absorb),
  `setClipSpeed` (contiguous-chain ripple), `setClipProperties`, `addTrack`/`removeTrack`/
  `setTrackMuted/Hidden/SyncLocked`, `seek`, selection, `undo`/`redo`, `load`. Wires the ported
  `rippleEngine`/`overwriteEngine`/`snapEngine` (`snapMoveFrame` for the drag UI).
- **`src/renderer/src/timeline/Timeline.tsx`** — a single Canvas-2D surface (not DOM-per-clip; 60fps):
  ruler, playhead, tracks with mute/hide/lock chips, clip rects (thumbnail / waveform sketch),
  drag-from-bin (HTML5 DnD → `addClip`), drag-to-move with sticky snapping + indicator, edge trim
  handles, split at playhead, ripple-delete, selection, wheel pan / ctrl-zoom.
- **Undo/redo** in the top bar + keyboard (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y, Del, S, ←/→).
- **Store** (`store.ts`) now mirrors the controller snapshot for React; the controller is the single
  source of truth for timeline + history. Save reads `controller.getTimeline()`; open calls `controller.load()`.

**Acceptance — met (see `EditorController.test.ts`):** a 3-track sequence with move/trim/split/ripple-delete
matches the ported engines; snapping engages with sticky hold; undo/redo reverses any edit exactly and a
JSON round-trip through `load()` restores it; an `agent`-tagged run of the same commands yields an identical
timeline to a `user` run. Interactive canvas gestures are build- and type-verified; drive them with `npm run dev`.

> **Decision:** used a raw Canvas-2D timeline instead of react-konva / pixi.js (the original suggestion) to
> avoid a new dependency and keep full control of hit-testing — a single canvas already clears the
> "not DOM-per-clip / 60fps" bar.

## 8. Phases 3–5 ✅ done (this session)

- **P3 — preview.** `core/preview/compositor.ts` `composeFrame(timeline, frame)` resolves the ordered
  visual layers (transform/opacity/crop/source-time, top track = foreground, skips hidden) and audio gains
  (skips muted) — pure, 6 tests. `renderer/src/preview/Preview.tsx` composites those layers onto a letterboxed
  canvas with a play/seek transport bound to `controller.seek`. *Remaining:* visual sources currently use the
  per-asset poster/thumbnail; frame-accurate video-decode playback needs pooled `<video>` fed by a
  main-process media protocol (renderer can't open arbitrary `file://` under the sandbox/CSP).
- **P4 — export.** `core/export/exportGraph.ts` `buildExportGraph(timeline, resolve, out)` turns a project into
  one FFmpeg `filter_complex` (scale/position/crop/opacity/fades/timing via overlay enable windows, z-order =
  track order; audio atempo/volume/delay/amix) — 11 unit tests. `main/ffmpeg/exporter.ts` resolves media paths
  and runs it; **the integration test renders a real 3-track project (video + image PIP + audio) to a playable
  mp4** and probes it. Wired to an **Export** button. *Remaining:* rotation/flip, text rendering, per-track
  blend modes, progress reporting.
- **P5 — AI command contract + in-app chat.** `core/ai/tools.ts` is one Zod-validated tool set +
  `executeTool(controller, …)` that dispatches to EditorController commands as `agent`-tagged undo steps;
  `toJsonSchemaTools()` emits the transport-ready (Anthropic/MCP) JSON-Schema tool list — 11 tests. The
  **in-app chat is wired** (BYOK): the key is stored encrypted in main (`main/ai/secrets.ts`, safeStorage);
  `main/ai/anthropic.ts` is a thin authenticated proxy; `renderer/src/ai/agent.ts` runs the tool loop
  (`runAgent`, model call injected → 6 tests) against the live controller; `ChatPanel.tsx` is the UI. The key
  never reaches the renderer. *Remaining:* token streaming (currently one response per turn).

## 9. Phase 6 ✅ done — embedded MCP server

External agents drive Reelo through the **same** P5 tool contract, over Streamable HTTP on localhost.

- `main/mcp/server.ts` — `createMcpHttpServer({ port, execute })` registers every tool from `editorTools`
  (advertised via their Zod input schemas) on an MCP `McpServer`, served by `StreamableHTTPServerTransport` on
  `127.0.0.1` (default port 4399; `REELO_MCP_PORT` overrides, `REELO_NO_MCP` disables). DNS-rebinding
  protection on by default. `execute` is injected → node-testable.
- `main/mcp/bridge.ts` — `executeToolInRenderer` forwards each `tools/call` to the focused window; the renderer
  (`src/ai/mcpBridge.ts`) runs `executeTool` against the live controller and replies (option **(a)**, per the owner).
- `@modelcontextprotocol/sdk` is ESM-only but ships a CJS build via its `require` export condition, so the CJS
  main bundle requires it directly — no bundling/dynamic-import workaround needed.

**Verified:** a real MCP client connects over HTTP and lists + calls tools against a controller
(`server.test.ts`); the server boots in the real app (`listening at …:4399/mcp`).

**Client config (example — while Reelo is running):**

```json
{ "mcpServers": { "reelo": { "url": "http://127.0.0.1:4399/mcp" } } }
```

## 10. Phase 8 ✅ done — Windows installer

`electron-builder.yml` (NSIS, x64) packages the electron-vite output. Decisions applied: **bundle FFmpeg**,
**unsigned for now**, **GitHub Releases auto-update**.

- **Bundled FFmpeg:** `npm run fetch:ffmpeg` (`scripts/fetch-ffmpeg.mjs`) downloads a GPL win64 build into
  `resources/ffmpeg/` (gitignored); electron-builder ships it via `extraResources`; main points
  `REELO_FFMPEG/FFPROBE` at it when packaged (env still overrides).
- **Auto-update:** `electron-updater` checks GitHub Releases (`soysebas-reyes/reelo`) on packaged startup.
- **Build:** `npm run dist` (= fetch ffmpeg → electron-vite build → electron-builder) produces
  `release/Reelo-<version>-setup.exe`. `npm run pack` makes an unpacked `--dir` build for quick testing.

> Runs on a build machine (electron-builder fetches electron + NSIS binaries; the ffmpeg script needs network),
> so the installer isn't produced in the headless verify env — the config, scripts, and runtime wiring are
> verified to the typecheck/build level (`electron-builder --version` and the fetch script's syntax check pass).

**Production follow-ups (optional):** add `build/icon.ico` (256×256) and uncomment `win.icon`; to sign, set
`win.certificateFile` + `certificatePassword` (or `CSC_LINK`/`CSC_KEY_PASSWORD`); cut the first GitHub Release
so auto-update has a feed.

> Generation providers (the original Higgs Field / fal.ai / Replicate SDK work) are **deferred**: the current
> workflow generates externally and imports the result as media, which already works end-to-end.

## 11. Higgsfield MCP interop

Higgsfield ships an official OAuth MCP server (`https://mcp.higgsfield.ai/mcp`) that bills your existing
**plan credits** (no API key) — so it works on a subscription without separate API funds.

- **Model A (done):** add both MCP servers to your Claude client (Higgsfield + Reelo at :4399). The agent
  generates in Higgsfield and places the result in Reelo; prompt approval is the client's built-in tool
  permission prompt. The connective piece — **`import_media`** — is built: a host-executed tool (declared in
  the @core contract, run by the renderer via `runEditorTool`) that imports local paths or http(s) URLs into
  the bin and returns assetId(s) for `add_clip`. Exposed on both the MCP server and the in-app agent.
- **Model B (proposed):** Reelo's own AI panel orchestrates — proposes a generation plan (prompt + model +
  duration + target track), shows it in an **approval queue** (edit / approve / reject) BEFORE sending, then
  calls Higgsfield (as an MCP client, OAuth in-app) and auto-imports + places approved results. This is where
  the prompt-approval gate truly lives. Requires adding an MCP client + OAuth flow in Reelo.

> "Remove silences" / "arrange" are Reelo edits (FFmpeg), not generation. "Upscale my own footage to HD"
> is **not** a confirmed Higgsfield capability — verify before relying on it.

## 12. Phases 13–15 ✅ done — editor workflow (sync / audio / angles → take detection → NLE handoff)

The product framing settled here: **Reelo complements CapCut/Premiere, it doesn't replace them.** It does
the technical, repeatable work — colorize, sync, enhance audio, switch angles, segment by scripts — then hands
a still-editable project to a finishing editor. All merged to `main`.

- **P13 — sync / audio / angles.** Multicam **sync** by audio cross-correlation (`core/edit/audioSync.ts`
  envelope correlation, no FFT; main-side PCM decode) places two angles at the matching offset with a shared
  `linkGroupId`. **Audio enhancement** = a non-destructive per-clip voice-cleanup/loudness chain
  (`core/model/audioEnhance*.ts` → `buildEnhanceChain`), live via Web Audio and baked exactly on export.
  **Angle switching** = `core/ai/angleCut.ts` (non-destructive `opacity 0` or ripple), plus track `role`s.
- **P14 — "Segmentar por guiones" (take detection).** `main/ai/analyzeTakes.ts` transcribes the raw clip
  (ElevenLabs Scribe, cached in `cache/transcripts.json`) and runs a forced-tool `claude-sonnet-5` pass that
  aligns each pasted guión to the span where it was recorded (`core/ai/scriptAlign.ts`) and optionally cuts
  fillers/repeats/silences. Each accepted take opens as a **clean, editable tab** (`buildTakeTimeline` clones
  the whole multicam timeline and ripple-deletes the complement, preserving both angles + color + sync). Tabs
  are a multi-session registry mirrored by the Zustand store and persisted in **`sessions.json`**. UI: input
  modal (paste guiones + `cleanCuts` toggle) → verification modal with an **editable take-boundary preview**
  (`renderer/src/takes/TakesPreview.tsx`, drag handles over a proxy `<video>`, `setTakeBounds`).
  - *Sync robusto (fix del "lateral con lag"):* el offset entre ángulos se estima SIEMPRE con los dos
    métodos — correlación RMS (`computeAudioOffset`) **y** alineación por transcript (`alignByTranscript`) —
    y se **reconcilia** en `core/edit/syncOffset.ts`: si un pico RMS confiable contradice al transcript, gana
    el RMS (`transcript-refuted`; antes un transcript envenenado con offset 0 y confianza alta se horneaba
    silencioso). El botón "Sincronizar" y el tool `sync_angles` comparten ese camino (`computeSyncOffsetFor`),
    y el tool ya **no aplica** offsets de baja confianza sin `force: true`.
  - *Auto-sync al segmentar:* `analyzeTakes` corre `ensureAnglesSynced` primero — con exactamente 2 ángulos
    de video sin `linkGroupId` compartido y solapados (`findUnsyncedAnglePair`), sincroniza solo (audio del
    clip elegido en el modal; default pista superior) antes de transcribir/armar tabs; estados ambiguos solo
    avisan. Red de seguridad por tab: `verifyLinkedAlignment` re-impone la co-alineación de los clips
    vinculados (mismo startFrame + delta de trim de la base) y mide `io.take_align_fix` si corrigió algo.
- **P15 — NLE handoff + MCP flow.** The **"Enviar a editor"** button writes an editable project + baked media.
  - *Format:* **FCP7 legacy XML (`xmeml`)**, chosen over FCPXML because Premiere's FCPXML importer is
    deprecated while Premiere + DaVinci Resolve + Final Cut all import xmeml reliably — and our frame-based
    timeline maps to xmeml's integer timebase with no rounding.
  - *Baked media (per source):* `core/interchange/bakePlan.ts` renders ONE file per distinct
    (source × grade × audio × flip) with our color + audio-enhancement applied (per-clip only when speed ≠ 1),
    reusing the export chain builders; a source that needs neither grade nor enhancement is referenced
    unchanged. `core/interchange/fcp7xml.ts` lays out cuts/trims/opacity/crop/transform/volume + A/V links;
    keyframes/fades and text clips are dropped (the editor re-adds them) and reported as warnings.
  - *Orchestration:* `main/interchange/handoff.ts` `runHandoff` bakes with ffmpeg and writes
    `handoff/<project>-<timestamp>/` (`.xml` + `media/` + `luts/` + README). IPC `project:handoff` /
    `project:pickHandoffDir`; store `exportToNle`; a topbar "Enviar a editor ▾" dropdown + a Reelo progress modal.
  - *MCP flow:* new host-executed tools close the Claude-Code workflow — `segment_by_scripts` (guiones),
    `export_to_nle`, `new/open/save_project` (the store's open/save now take an optional `dir` for headless
    use) — and `media/importSources.ts` downloads platform links (YouTube/Instagram/TikTok/…) via **yt-dlp**
    (direct URLs still use `fetch`). Connection + full flow: [`../MCP.md`](../MCP.md); smoke script `mcp_flow.mjs`.
  - *Pending (needs the owner's environment):* import the `.xml` into a real Premiere/Resolve/FCP and confirm
    timing/color/audio (tune per-NLE quirks in the README); run the MCP flow with the app open + Claude Code.
  - **CapCut writer (done).** `export_to_nle` now takes `target: 'capcut'` too. `core/interchange/capcutDraft.ts`
    (pure, golden-tested) turns the timeline + the SAME per-source baked media into a CapCut **draft folder**
    (`draft_content.json` + `draft_meta_info.json` + `media/`): integer-microsecond `target/source_timerange`,
    one `material` per baked source, one `segment` per clip, per-segment `speed`/`canvas`/`sound_channel_mapping`
    helpers, `render_index` back-to-front, transform/alpha/volume carried (a video segment plays its own
    embedded audio, so no linked audio segment). Text/lottie/keyframes/fades **and non-identity crop** are
    dropped as warnings (parity note: xmeml keeps crop). `main/interchange/capcutLocate.ts` auto-detects
    CapCut's Windows draft root (`%LOCALAPPDATA%\CapCut\User Data\Projects\com.lveditor.draft`, +JianYing,
    `REELO_CAPCUT_DRAFT_DIR` override) so "Enviar a editor ▸ CapCut" drops the draft straight where CapCut
    lists it — no picker; if CapCut isn't found it falls back to a picked folder + README move instructions.
    `runHandoff` branches on target (draft folder is a DIRECT child of the root, no `handoff/` wrapper).
    Unit + ffmpeg-integration green; **pending on-device verification** that a real CapCut build opens the
    draft (version stamps in `capcutDraft.ts` may need tuning per CapCut release).

## 13. Reference docs
- Full original architecture/plan (private, owner's machine): `~/.claude/plans/cosmic-mapping-swan.md`
- Upstream agent tool contract (for P5/P6): `reference/.../Agent/Tools/ToolDefinitions.swift` (~30 tools)
- Higgs Field SDK (for P7): `@higgsfield/client` — confirm endpoint ids/params before coding.

## 14. Phase 16 ✅ P16.0 done — Medición total (telemetría de comportamiento)

**Por qué existe.** Queremos saber cómo se usa la herramienta de verdad (qué se toca, qué se
ignora, dónde hay fricción, cuánto se queda la gente, user vs agente) para poder optimizar — y que
esa medición **no se degrade** cuando la app cambie. Medimos **comportamiento**, jamás **contenido**
(nunca frames/audio, rutas, nombres de medios/proyecto, transcripciones ni texto de chat/prompt).
El contrato de "toda feature debe instrumentarse" vive en [`../CLAUDE.md`](../CLAUDE.md); el detalle
técnico y la privacidad, en [`TOTAL_MEASUREMENT_PLAN.md`](./TOTAL_MEASUREMENT_PLAN.md).

**Las 3 capas de captura** (cuelgan de invariantes que no cambian → "always-valid"):
1. **Física** — listeners globales en fase de captura (`src/renderer/src/telemetry/physical.ts`):
   clics, `pointermove` muestreado, teclas (nunca el texto tecleado), rueda, dwell por panel.
   Cualquier UI nueva se mide sola.
2. **Comandos** — el hook IoC `setCommitObserver` en `EditorController.run()` (@core, sin importar
   telemetría): cada edición commit-eada se normaliza a un id estable (`command.split_clip`; libre →
   `command.other`) con `origin` user/agent. `src/renderer/src/telemetry/semantic.ts`.
3. **IO / IA** — auto-wrap de las acciones del store + el único seam `runEditorTool` (todas las ~47
   tools de agente/MCP). `src/renderer/src/telemetry/{io.ts, ../ai/runTool.ts}`.

**Core + sink + identidad.** Core puro en `src/core/telemetry/` (schema Zod + `taxonomy` + `redact`).
El renderer envía lotes por IPC fire-and-forget (`telemetry:events`); main valida con Zod (es el
límite de confianza, sobre-escribe identidad/versión) y escribe **JSONL append-only** en
`userData/telemetry/` detrás de `TelemetrySink` (`src/main/telemetry/`). Identidad = `anonymousId`
persistente (la FK futura a la cuenta) + `sessionId` por lanzamiento.

**El guardrail (obligatorio).** `src/core/telemetry/taxonomy.test.ts` rompe `npm test` si una tool
de `editorTools` o un literal de comando en `EditorController.ts` no está registrado en el taxonomy.
Los IDs de taxonomy son unión cerrada → referenciar uno inexistente rompe compilación. Por eso
instrumentar es parte de la *definition of done* (ver `CLAUDE.md`).

**Privacidad y opt-out.** Redacción por *allowlist*/scrub (rutas/URLs/emails/`data:` → `[redacted]`)
en el renderer y re-validación en main. Local hoy = habilitado por defecto, cero egress; kill switch
`REELO_NO_TELEMETRY=1`. **El futuro upload a la nube será opt-IN** con consentimiento + política.

**Roadmap.** P16.0 captura local + JSONL ✅ · P16.1 inspección/dashboard local + auditoría de
redacción · P16.2 Supabase (tabla `events`/`identities`, RLS por `user_id`, Auth vía main +
`safeStorage`, outbox/cursor offline-first, linkage `anonymousId → user_id`). Diseño completo en
[`TOTAL_MEASUREMENT_PLAN.md`](./TOTAL_MEASUREMENT_PLAN.md).
