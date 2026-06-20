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
| **P3** | Editor: real-time multi-track preview | ✅ done (still-frame composite; video-decode playback pending) |
| **P4** | Editor: FFmpeg export | ✅ done (real render, integration-tested) |
| **P5** | AI: agent tool contract (Zod) + executor | ✅ done — in-app chat transport (BYOK) pending |
| **P6** | AI: embedded MCP server (Claude Code / Cursor / Claude Desktop) | ⬜ next — needs `@modelcontextprotocol/sdk` + main↔renderer proxy |
| P7 | Generation: Higgs Field (multi-provider adapter) | ⬜ — needs provider SDK + BYOK key + network |
| P8 | Generation: fal.ai/Replicate + Windows installer | ⬜ — needs SDKs + electron-builder |

**Verification bar (all green as of P5):** `npm run typecheck`, `npm run build`, `npm test` (166 tests,
incl. 29 EditorController command/undo, 6 compositor, 11 export-graph, 11 AI-tool tests, and 2 ffmpeg
integration suites — export render + media pipeline — that self-skip if ffmpeg is absent). The app also
boot-smoke-tested via `npm run dev`.

> **Scope note (this session executed P2→P5):** the editor is functionally complete — import, multi-track
> timeline editing, live preview, and real FFmpeg export — plus the transport-agnostic AI command contract.
> The remaining phases (P6 MCP server, P7/P8 generation + installer) are gated on external resources
> (SDK deps, BYOK API keys, network, electron-builder) and can't be runtime-verified headlessly, so they're
> deliberately left for sessions where those are available. The architecture is ready for them: the
> EditorController + Zod tool contract are exactly what the MCP server and in-app agent will call.

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
    ipc.ts                      # all ipcMain handlers (incl. project:export, pickExportPath)
    ffmpeg/ {binary,probe,thumbnail,index}.ts   # ffprobe/ffmpeg integration
    ffmpeg/exporter.ts          # runs buildExportGraph + spawns ffmpeg (P4)
    ffmpeg/exporter.test.ts     # renders a 3-track project end-to-end (self-skips if no ffmpeg)
    media/importer.ts           # classify → probe → thumbnail → manifest entry
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
npm test           # 166 tests (2 ffmpeg integration suites self-skip without ffmpeg)
npm run typecheck
npm run build      # production build into out/
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
- **P5 — AI command contract.** `core/ai/tools.ts` is one Zod-validated tool set + `executeTool(controller, …)`
  that dispatches to EditorController commands as `agent`-tagged undo steps; `toJsonSchemaTools()` emits the
  transport-ready (Anthropic/MCP) JSON-Schema tool list — 11 tests. *Remaining:* the in-app chat transport
  (`@anthropic-ai/sdk`, BYOK key) that turns model tool-calls into `executeTool` calls.

## 9. Next: Phase 6 — embedded MCP server (detailed)

**Goal:** expose the editor to external agents (Claude Code / Cursor / Claude Desktop) over MCP, reusing the
P5 contract verbatim.

**Steps**
1. Add `@modelcontextprotocol/sdk`. In **main**, stand up an MCP server whose `tools/list` is `toJsonSchemaTools()`
   and whose `tools/call` forwards to `executeTool`.
2. **State bridge:** the live timeline lives in the renderer's `EditorController`. Either (a) proxy each
   `tools/call` to the renderer over IPC and run it there, or (b) move the authoritative controller into main
   and have the renderer mirror it. (a) is less invasive; (b) is cleaner long-term — decide before coding.
3. Transport: stdio for Claude Desktop/Cursor; document the config snippet. Guard for headless/no-window runs.

**Then P7/P8 (gated on external resources):** P7 — a `GenerationProvider` interface + `JobManager` + static
`models.json`, **Higgs Field first** (`@higgsfield/client`, BYOK), then fal.ai/Replicate; generated clips flow
back through `addClip`. P8 — Windows packaging via electron-builder (NSIS), bundled ffmpeg, auto-update. These
need SDK deps, BYOK API keys, network, and a build/signing pipeline — not runnable in a headless verify session.

## 10. Reference docs
- Full original architecture/plan (private, owner's machine): `~/.claude/plans/cosmic-mapping-swan.md`
- Upstream agent tool contract (for P5/P6): `reference/.../Agent/Tools/ToolDefinitions.swift` (~30 tools)
- Higgs Field SDK (for P7): `@higgsfield/client` — confirm endpoint ids/params before coding.
