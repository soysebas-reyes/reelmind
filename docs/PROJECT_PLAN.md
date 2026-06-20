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
| **P2** | Editor: timeline editing (drag/trim/split/ripple/snap, undo/redo) | ⬜ next |
| P3 | Editor: real-time multi-track preview | ⬜ |
| P4 | Editor: FFmpeg export | ⬜ |
| P5 | AI: agent tool contract + in-app chat (BYOK) | ⬜ |
| P6 | AI: embedded MCP server (Claude Code / Cursor / Claude Desktop) | ⬜ |
| P7 | Generation: Higgs Field (multi-provider adapter) | ⬜ |
| P8 | Generation: fal.ai/Replicate + Windows installer | ⬜ |

**Verification bar (all green as of P1):** `npm run typecheck`, `npm run build`, `npm test` (107 tests,
incl. 5 ffmpeg integration tests that self-skip if ffmpeg is absent).

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
    testing/fixtures.ts         # fxClip / fxTrack / fxTimeline
    index.ts                    # barrel (import via "@core")
  shared/ipc.ts                 # wire types shared by main/preload/renderer
  main/
    index.ts                    # app lifecycle + window (sandbox, contextIsolation)
    ipc.ts                      # all ipcMain handlers
    ffmpeg/ {binary,probe,thumbnail,index}.ts   # ffprobe/ffmpeg integration
    media/importer.ts           # classify → probe → thumbnail → manifest entry
    media/mediaPipeline.test.ts # ffmpeg integration test (self-skips if no ffmpeg)
    project/projectStore.ts     # .vproj save/load (atomic writes)
  preload/index.ts(.d.ts)       # editorBridge (typed, sandboxed)
  renderer/
    index.html                  # CSP-locked shell
    src/{main.tsx,App.tsx,App.css,store.ts}     # Zustand store + media-bin UI
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
npm test           # 107 tests
npm run typecheck
npm run build      # production build into out/
```
Requirements: Node 20+ and **FFmpeg on PATH** (from P1 onward). Override binaries with env vars
`REELMIND_FFMPEG` / `REELMIND_FFPROBE` if needed.

## 7. Next: Phase 2 — timeline editing (detailed)

**Goal:** a canvas timeline where you build a multi-track sequence and edit it; every mutation goes
through a single `EditorController` so the AI agent (P5/P6) can later drive the same commands.

**Steps**
1. **`src/core/controller/EditorController.ts`** — the command API over the timeline + an Immer-patch
   undo/redo stack (one command = one undo step; tag transactions `user` vs `agent`). Core commands:
   `addClip`, `moveClip` (with snap), `trimClipStart/End`, `splitClip`, `removeClip`, `rippleDelete`,
   `overwriteClip`, `addTrack/removeTrack/setTrackMuted/Hidden`, `setClipProperties`, `seek`, query
   getters. Wire the **already-ported** `rippleEngine`/`overwriteEngine`/`snapEngine` here.
2. **Renderer timeline UI** on Canvas (recommend `react-konva` or `pixi.js`; DOM-per-clip won't hit
   60fps): ruler, playhead, tracks, clip rectangles (filmstrip/waveform), drag-from-bin, drag/move,
   trim handles, split at playhead, ripple-delete, snapping with indicator.
3. **Undo/redo** UI + keyboard (Ctrl+Z / Ctrl+Shift+Z).
4. **Tests:** unit-test `EditorController` command results against the engines; a few golden
   sequences (build 3 tracks, move/trim/split/ripple, undo all → original).

**Upstream files to port from (`reference/palmier-pro/Sources/PalmierPro/`)**
- `Editor/ViewModel/EditorViewModel*.swift` → the role of `EditorController` (ClipMutations, Ripple,
  Tracks, TimelineRange, Clipboard, Linking)
- `Timeline/TimelineView.swift`, `TimelineInputController.swift`, `ClipRenderer.swift`,
  `TimelineGeometry.swift`, `DragState.swift`, `SnapIndicatorOverlay.swift` → the canvas UI + input
- `Timeline/TimelineGeometry.swift` for px↔frame conversions (`Defaults.pixelsPerFrame = 4`)

**Acceptance:** build a 3+ track sequence; move/trim/split/ripple-delete match the ported engines;
snapping engages with sticky hold; undo/redo reverses any edit exactly; reload restores. An agent
calling the same `EditorController` commands produces identical results.

## 8. Reference docs
- Full original architecture/plan (private, owner's machine): `~/.claude/plans/cosmic-mapping-swan.md`
- Upstream agent tool contract (for P5/P6): `reference/.../Agent/Tools/ToolDefinitions.swift` (~30 tools)
- Higgs Field SDK (for P7): `@higgsfield/client` — confirm endpoint ids/params before coding.
