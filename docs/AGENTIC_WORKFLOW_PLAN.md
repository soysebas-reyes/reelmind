# Reelo — Agentic Workflow Plan (P11: copilot mode)

> Companion to [`PROJECT_PLAN.md`](./PROJECT_PLAN.md). Goal: let you **drive Reelo by talking to
> Claude** (the in-app chat or Claude Code over MCP) so the repetitive manual steps — loading a
> folder of raw clips, removing silences, basic edits, exporting — happen for you. You keep the app
> open to review in the preview; Claude does the grunt work.

Decided with the owner: **copilot mode** (app stays open) and all four capabilities:
**import a whole folder · remove silences · export on command · reusable recipes.**

---

## 1. How tool execution works today (the seam we build on)

- **One chokepoint:** every AI/MCP tool runs through `runEditorTool(name, input)`
  ([`runTool.ts`](../src/renderer/src/ai/runTool.ts)). Timeline tools go to the pure `executeTool`
  (over `EditorController`); **host tools** that touch disk / FFmpeg / the bin are special-cased there.
- **Both transports share it:** the in-app agent and the MCP bridge ([`mcpBridge.ts`](../src/renderer/src/ai/mcpBridge.ts))
  both call `runEditorTool`, so a new tool works in **both** at once.
- **The engine already exports & saves:** `project:export` (`ExportRequest{ outputPath }`),
  `project:save`, `media:importSources` exist in main ([`ipc.ts`](../src/main/ipc.ts)) and the preload
  bridge ([`index.ts`](../src/preload/index.ts)). They're just **not exposed as agent tools**, and the
  GUI reaches them through **native file dialogs** (the clicks you're tired of).
- **Copilot constraint:** the MCP server lives inside the Electron main process, so Claude Code can
  drive Reelo **only while the app is open**. That's fine for copilot mode; a true headless/no-GUI
  batch mode is a separate, larger effort (extract the engine to a CLI) — deferred.

**Friction-killer principle:** every new tool takes **paths as parameters** (no native dialogs), and
`summarizeTimeline` exposes the asset ids / refs Claude needs to chain steps.

---

## 2. The four capabilities

### 2.1 `import_folder` — load a whole folder ✅ (this pass)
- **Tool (host-executed):** `import_folder({ folderPath, types? })` → returns the imported asset ids.
- **Main:** `importMediaFromSources` ([`importSources.ts`](../src/main/media/importSources.ts)) expands
  any source that is a **directory** into its media files (by extension, non-recursive v1) and runs the
  normal import pipeline. So a folder path "just works" as a source.
- **Renderer:** `runEditorTool` adds an `import_folder` case → `store.importFromSources([folderPath])`.

### 2.2 `export` — render on command, no dialog ✅ (this pass)
- **Tool (host-executed):** `export({ outputPath, crf?, preset? })` → renders the current timeline to
  `outputPath` and returns `{ outputPath, durationSeconds }`.
- **Renderer:** new `store.exportToPath(outputPath, opts)` reuses `editorBridge.exportTimeline`
  (the existing `project:export`) **without** the native picker; `runEditorTool` adds an `export` case.
- No engine/main change needed — `ExportRequest` already carries `outputPath`.

### 2.3 `remove_silences` — auto-cut dead air 🔜 (next, needs decisions)
- **Analysis (main):** run FFmpeg `silencedetect` on a clip's source audio → parse `silence_start` /
  `silence_end` pairs. New IPC `media:detectSilences(path, { noiseDb, minDurationSec })`.
- **Edits (controller):** map silence ranges (timeline frames, honoring trim/speed) → `splitClip` at
  each boundary + `rippleDelete` the silent segments, as **one** `agent` undo step.
- **Open decisions:** default threshold (`noiseDb` ≈ -30 dB), `minDurationSec` (≈ 0.5 s), keep-padding
  around speech (≈ 0.1 s); and **scope** — selected clip, one track, or the whole timeline?

### 2.4 Recipes — reusable named workflows 🔜 (next, needs decisions)
- A **recipe** = an ordered list of steps (import folder → remove silences → apply color profile →
  export) saved by name ("YouTube", "Personal brand"). Stored app-level like the P9 color profiles
  (`userData/recipes.json`), so they persist across projects.
- **Tool:** `run_recipe({ name, folderPath?, outputDir? })` + `list_recipes()`. Ties directly into the
  P9 saved color profiles (a recipe can reference one).
- **Open decisions:** recipe authoring (chat-defined vs a small UI), per-file vs single-timeline batch,
  and naming/overwrite semantics.

---

## 3. Target experience

From Claude Code (app open) or the in-app chat:

> *"Import everything in `D:\crudos`, drop each on its own track, remove silences, apply my
> **Personal brand** look, and export each to `D:\salida` at 1080p."*

Claude calls `import_folder` → (`remove_silences`) → (`apply_color_preset`) → `export`. You watch the
preview if you want; the only thing you must do is say what you want and, optionally, review.

---

## 4. Implementation order
1. **`import_folder` + `export`** ✅ shipped.
2. **`remove_silences`** ✅ shipped (defaults -30 dB / 0.5 s / 0.1 s padding; targets `clipId` → selection → the only audible track, else lists candidates).
3. **Recipes** (after silences; layers on top, ties to P9 color profiles).
4. *(Later, optional)* headless CLI for no-GUI batch.

## 5. P12 additions (CapCut-parity pass)

The copilot surface grew far beyond the original four capabilities — see `PROJECT_PLAN.md` P12. The
agent-facing highlights: `batch_operations` (N core edits = 1 IPC round-trip = 1 undo step),
`inspect_clip` + `list_assets` (the agent can finally READ state cheaply), `get_frame_preview` (the
agent SEES the composited frame — real image blocks in both the in-app chat and MCP),
`apply_color_preset`, keyframe tools (`set_keyframe`/`remove_keyframe`/`get_keyframes`),
`ripple_delete_range`, `add_text_clip`, and per-tool transport timeouts (export gets 30 min).
