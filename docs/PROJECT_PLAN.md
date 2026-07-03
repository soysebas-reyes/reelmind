# ReelMind — Project Plan & State

> **For anyone (or any AI chat) picking this up fresh:** read this file top to bottom, then
> [`ATTRIBUTION.md`](../ATTRIBUTION.md) and [`README.md`](../README.md). This is the single source
> of truth for what's built, why, and what comes next.

---

## 1. What this project is

**ReelMind** is an open-source, **AI-native video editor for Windows**, built as an independent,
cross-platform derivative of **[palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro)**
(a native macOS/Swift app, GPL-3.0). We keep ReelMind public, GPL-3.0, and credit Palmier.

- **Public repo:** https://github.com/soysebas-reyes/reelmind
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
| **P12** | CapCut parity — MCP tool surface + manual UX | ✅ core pass done (5 milestones, branch `feat/p95-colorization-core`): widened `set_clip_properties` (text/transform/crop/audioEnhance) + `set_clips_properties`, `inspect_clip`, `list_assets`, `list/apply_color_preset`, `batch_operations` (1 IPC = 1 undo), keyframe tools, `ripple_delete_range`, `add_text_clip`, `get_frame_preview` (composited frame as a REAL image block in both transports), per-tool timeouts, `sync_angles` frames; UX: Space play/pause + `[`/`]`/Home/End/±zoom, Ctrl+C/X/V/D clipboard, right-click context menus (clip/track/empty), ClipInspector "Propiedades" tab (transform/opacity/speed/fades/volume, coalesced-undo sliders), multi-select group drag, OS drag-and-drop, inline fade handles, bigger transport + frame-step + preview rate. 353 tests green. Pending (bigger core work): text rendering in preview-style + export (drawtext), transitions, keyframe curve UI, markers |

**Verification bar (all green as of P6):** `npm run typecheck`, `npm run build`, `npm test` (173 tests,
incl. 29 EditorController command/undo, 6 compositor, 11 export-graph, 11 AI-tool, 6 agent-loop, and a real
MCP client↔server HTTP integration test, plus 2 ffmpeg integration suites — export render + media pipeline —
that self-skip if ffmpeg is absent). The app boot-smoke-tests via `npm run dev`: the AI panel + Anthropic SDK
load in main, the media protocol serves video, and the MCP server logs `listening at http://127.0.0.1:4399/mcp`.

> **Scope note (this session executed P2→P5 incl. the in-app AI chat):** the editor is functionally complete —
> import, multi-track timeline editing, live preview, real FFmpeg export — and the **AI editor chat is wired**
> (BYOK Anthropic key, encrypted via safeStorage in main; the agent drives the exact same EditorController
> commands the UI does). Remaining: P6 (MCP server — needs `@modelcontextprotocol/sdk` + the main↔renderer
> proxy) and P7/P8. **P7 is descoped to import-based**: scenes are generated externally (e.g. Higgsfield) and
> imported as media assets, which the existing P1 pipeline already handles — no provider SDK/key needed.
> P8 (Windows installer) still needs electron-builder + signing/auto-update decisions.

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
    ai/tools.ts                 # Zod tool contract + executeTool over EditorController (P5);
                                #   toJsonSchemaTools() for Anthropic/MCP transports
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
    media/importer.ts           # classify → probe → thumbnail → manifest entry
    media/mediaProtocol.ts      # reelmind-media:// — streams local files to the renderer (P3 video)
    media/mediaPipeline.test.ts # ffmpeg integration test (self-skips if no ffmpeg)
    project/projectStore.ts     # .vproj save/load (atomic writes)
  preload/index.ts(.d.ts)       # editorBridge (typed, sandboxed) — adds export methods
  renderer/
    index.html                  # CSP-locked shell
    src/{main.tsx,App.tsx,App.css}              # shell, bin + preview + timeline layout, topbar
    src/store.ts                # Zustand store mirrors the EditorController; project IO + export
    src/timeline/geometry.ts    # px↔frame layout math (ruler/tracks/clips)
    src/timeline/Timeline.tsx   # Canvas timeline: drag-from-bin, move+snap, trim, split, ripple
    src/preview/Preview.tsx     # composited preview canvas + transport (play/seek)
    src/ai/{agent.ts,ChatPanel.tsx}  # in-app agent loop (executeTool) + BYOK chat UI (P5)
    src/ai/mcpBridge.ts         # answers main's MCP tool-execute requests via executeTool (P6)
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
npm run dev        # launches the ReelMind window with hot reload
npm test           # 173 tests (3 ffmpeg/MCP integration suites self-skip without their deps)
npm run typecheck
npm run build      # production build into out/
npm run dist       # build a Windows installer (fetch ffmpeg → build → electron-builder) [build machine]
# To export: add clips to the timeline, then Export in the top bar (renders via FFmpeg).
```
Requirements: Node 20+ and **FFmpeg on PATH** (from P1 onward). Override binaries with env vars
`REELMIND_FFMPEG` / `REELMIND_FFPROBE` if needed.

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

External agents drive ReelMind through the **same** P5 tool contract, over Streamable HTTP on localhost.

- `main/mcp/server.ts` — `createMcpHttpServer({ port, execute })` registers every tool from `editorTools`
  (advertised via their Zod input schemas) on an MCP `McpServer`, served by `StreamableHTTPServerTransport` on
  `127.0.0.1` (default port 4399; `REELMIND_MCP_PORT` overrides, `REELMIND_NO_MCP` disables). DNS-rebinding
  protection on by default. `execute` is injected → node-testable.
- `main/mcp/bridge.ts` — `executeToolInRenderer` forwards each `tools/call` to the focused window; the renderer
  (`src/ai/mcpBridge.ts`) runs `executeTool` against the live controller and replies (option **(a)**, per the owner).
- `@modelcontextprotocol/sdk` is ESM-only but ships a CJS build via its `require` export condition, so the CJS
  main bundle requires it directly — no bundling/dynamic-import workaround needed.

**Verified:** a real MCP client connects over HTTP and lists + calls tools against a controller
(`server.test.ts`); the server boots in the real app (`listening at …:4399/mcp`).

**Client config (example — while ReelMind is running):**

```json
{ "mcpServers": { "reelmind": { "url": "http://127.0.0.1:4399/mcp" } } }
```

## 10. Phase 8 ✅ done — Windows installer

`electron-builder.yml` (NSIS, x64) packages the electron-vite output. Decisions applied: **bundle FFmpeg**,
**unsigned for now**, **GitHub Releases auto-update**.

- **Bundled FFmpeg:** `npm run fetch:ffmpeg` (`scripts/fetch-ffmpeg.mjs`) downloads a GPL win64 build into
  `resources/ffmpeg/` (gitignored); electron-builder ships it via `extraResources`; main points
  `REELMIND_FFMPEG/FFPROBE` at it when packaged (env still overrides).
- **Auto-update:** `electron-updater` checks GitHub Releases (`soysebas-reyes/reelmind`) on packaged startup.
- **Build:** `npm run dist` (= fetch ffmpeg → electron-vite build → electron-builder) produces
  `release/ReelMind-<version>-setup.exe`. `npm run pack` makes an unpacked `--dir` build for quick testing.

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

- **Model A (done):** add both MCP servers to your Claude client (Higgsfield + ReelMind at :4399). The agent
  generates in Higgsfield and places the result in ReelMind; prompt approval is the client's built-in tool
  permission prompt. The connective piece — **`import_media`** — is built: a host-executed tool (declared in
  the @core contract, run by the renderer via `runEditorTool`) that imports local paths or http(s) URLs into
  the bin and returns assetId(s) for `add_clip`. Exposed on both the MCP server and the in-app agent.
- **Model B (proposed):** ReelMind's own AI panel orchestrates — proposes a generation plan (prompt + model +
  duration + target track), shows it in an **approval queue** (edit / approve / reject) BEFORE sending, then
  calls Higgsfield (as an MCP client, OAuth in-app) and auto-imports + places approved results. This is where
  the prompt-approval gate truly lives. Requires adding an MCP client + OAuth flow in ReelMind.

> "Remove silences" / "arrange" are ReelMind edits (FFmpeg), not generation. "Upscale my own footage to HD"
> is **not** a confirmed Higgsfield capability — verify before relying on it.

## 12. Reference docs
- Full original architecture/plan (private, owner's machine): `~/.claude/plans/cosmic-mapping-swan.md`
- Upstream agent tool contract (for P5/P6): `reference/.../Agent/Tools/ToolDefinitions.swift` (~30 tools)
- Higgs Field SDK (for P7): `@higgsfield/client` — confirm endpoint ids/params before coding.
