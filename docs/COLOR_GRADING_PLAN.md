# ReelMind — Color Grading & Colorization Plan (P9 + P10)

> Companion to [`PROJECT_PLAN.md`](./PROJECT_PLAN.md). Two phases:
> **P9 — manual color grading** (per-clip adjustments, look presets, `.cube` LUTs, AI control,
> and **reusable saved color profiles** like *"Personal brand"* / *"Work"*), then
> **P10 — AI colorization** (B&W → color), deferred to a later pass.

---

## 0. Why this fits ReelMind cleanly

The architecture already has the right seams, so color is mostly *additive*:

- **One shared compositor.** `composeFrame(timeline, frame)` ([`compositor.ts`](../src/core/preview/compositor.ts))
  is the single source of truth for both the live preview and the FFmpeg export. Define a color
  adjustment **once** on the layer and it shows up in **both** preview and render.
- **`Clip` is plain JSON.** Adding a `color` field persists for free in `.vproj` (no schema/IO work).
- **One command pattern.** `setClipProperties` + the `EDITABLE_KEYS` whitelist
  ([`EditorController.ts:105`](../src/core/controller/EditorController.ts)) is exactly where a color
  edit hooks in — which means undo/redo and `user`/`agent` tagging come for free.
- **One AI tool contract.** Adding `set_clip_color` to [`tools.ts`](../src/core/ai/tools.ts) exposes
  color to **both** transports (in-app chat + MCP) at once.

> **Known gap this also closes:** there is no clip **inspector** in the UI today — `opacity`/`volume`/
> `fades`/`transform` can only be changed by gestures or the agent. P9 introduces the inspector panel,
> which is the natural home for color *and* those existing-but-UI-less properties.

---

## 1. Phase 9 — Manual color grading

### 1.1 Data model — `src/core/model/color.ts` (new)

A neutral-by-default, JSON-serializable adjustment block. All ranges are chosen so **0 / 1 = identity**
(so a clip with no grading emits no filters and renders bit-for-bit as before).

```ts
export interface ColorAdjustments {
  exposure: number     // -2..2 stops      (0 neutral)
  brightness: number   // -1..1            (0)
  contrast: number     //  0..2            (1)
  saturation: number   //  0..2            (1)
  temperature: number  // -100..100 warm/cool (0)
  tint: number         // -100..100 green/magenta (0)
  hue: number          // -180..180 deg    (0)
  gamma: number         // 0.1..3          (1)
  lutRef?: string      // project-relative path or profile LUT id (optional)
  lutIntensity?: number // 0..1            (1)
}

export function makeColorAdjustments(p?: Partial<ColorAdjustments>): ColorAdjustments
export function colorIsIdentity(c: ColorAdjustments): boolean   // skip all filters when true
export function mergeColor(base: ColorAdjustments, patch: Partial<ColorAdjustments>): ColorAdjustments
```

- Add `color?: ColorAdjustments` to the `Clip` interface in
  [`timeline.ts:93`](../src/core/model/timeline.ts). **Leave it `undefined` in `makeClip`** (undefined =
  identity) so existing projects and un-graded clips stay lean.
- Add a pure accessor `colorAt(clip, frame): ColorAdjustments` next to `opacityAt`/`transformAt`.
  v1 is static (`return clip.color ?? IDENTITY`); a future `colorTrack?: KeyframeTrack<ColorAdjustments>`
  slots in here for animated grades (same pattern as `opacityTrack`).

### 1.2 Compositor — `compositor.ts`

- Add `color: ColorAdjustments` to `VisualLayer`.
- In `composeFrame`, populate `color: colorAt(clip, frame)` when building each visual layer
  ([`compositor.ts:88`](../src/core/preview/compositor.ts)). Pure, covered by a new golden test.

### 1.3 Preview — `Preview.tsx` (Canvas 2D)

Map `ColorAdjustments` → a Canvas `ctx.filter` string (CSS filter functions are supported in
Chromium/Electron) and set it before `drawSource`, reset after:

| Adjustment | Canvas filter (preview) |
|---|---|
| brightness / exposure | `brightness(...)` |
| contrast | `contrast(...)` |
| saturation | `saturate(...)` |
| hue | `hue-rotate(deg)` |
| temperature / tint | approximated (`sepia`+`hue-rotate`, or a tint overlay) |
| gamma | approximated via brightness/contrast |
| LUT | **not** in 2D canvas → preview shows pre-LUT (or approximates); exact LUT only in export for v1 |

> **Fidelity note (call it out in the UI):** the preview is a fast *approximation* for basic
> adjustments; the **FFmpeg export is exact**. Temperature/tint and LUTs are the lossy parts.
> A **v1.1** can move the preview compositor to **WebGL** for 1:1 fidelity (true gamma, temperature
> matrix, and `.cube` LUT sampling in-shader). Flag, don't block.

### 1.4 Export — `exportGraph.ts`

Insert color filters into each visual clip's `filters` array, **after `scale`, before
`format=yuva420p`** ([`exportGraph.ts:144`](../src/core/export/exportGraph.ts)). Only emit a filter
when its field differs from identity (gate on `colorIsIdentity` + per-field checks) so un-graded clips
are untouched.

| Adjustment | FFmpeg filter |
|---|---|
| brightness/contrast/saturation/gamma/exposure | `eq=brightness=..:contrast=..:saturation=..:gamma=..` |
| hue | `hue=h=..` |
| temperature | `colortemperature=temperature=..` |
| tint | `colorbalance=...` (mid green/magenta) |
| LUT | `lut3d=file='<resolved .cube>':interp=tetrahedral` (intensity<1 via split+blend in v1.1) |

This is the only place exact color lands; covered by `exportGraph.test.ts` assertions on the emitted
`filter_complex`.

### 1.5 EditorController

- Add `color?: ColorAdjustments` to `ClipPropertyEdit` and to `EDITABLE_KEYS`
  ([`EditorController.ts:105`](../src/core/controller/EditorController.ts)) → `setClipProperties` handles
  it with undo/redo automatically.
- Add a convenience `setClipColor(clipId, patch: Partial<ColorAdjustments>, label?)` that **merges**
  (so a single slider doesn't reset the others) and runs as one undo step. Used by both the inspector
  sliders and the AI tool.

### 1.6 AI control — `tools.ts`

- New tool **`set_clip_color`**: `{ clipId, exposure?, brightness?, contrast?, saturation?,
  temperature?, tint?, hue?, gamma? }` → `setClipColor` (partial merge). Rich description with the
  ranges so the model grades sensibly.
- New tool **`apply_color_preset`**: `{ clipId | clipIds, preset }` (built-in look or a saved user
  profile by name — see §1.8). Enables *"apply my Personal-brand look to all clips."*
- Extend `summarizeTimeline` to include each clip's `color` so the agent can see current grades.

### 1.7 Built-in look presets — `src/core/color/presets.ts` (new)

Static catalog, each preset = a partial `ColorAdjustments`: `warm`, `cool`, `teal-orange` (cinematic),
`vintage`, `bw` (saturation 0), `high-contrast`, `muted`, `vivid`. Applying = merge onto current color.

### 1.8 ★ Reusable saved color profiles (the "learn my settings" requirement)

This is the part you specifically asked for: ReelMind should **remember named, reusable looks** (e.g.
*"Personal brand"*, *"Work"*) that persist **across projects** and can be reapplied — by you or by the AI.

- **App-level store (not per-project):** `main` writes `colorProfiles.json` under
  `app.getPath('userData')`. Each profile: `{ id, name, color: ColorAdjustments, lutRef?, isDefault?,
  createdAt }`.
- **IPC** (new handlers in [`main/ipc.ts`](../src/main/ipc.ts) + preload bridge):
  `color:listProfiles`, `color:saveProfile`, `color:deleteProfile`. LUT files referenced by a profile
  are copied into the userData store so profiles are self-contained.
- **UI:** in the color inspector — a "Save as profile…" action (name it), an "Apply profile" dropdown,
  and a "Set as default for new clips" toggle.
- **AI:** `apply_color_preset` resolves a profile by name, and a `list_color_profiles` tool lets the
  agent discover them → *"grade everything with my Work profile."*
- **Roadmap (auto-learn):** once grades accumulate, infer a profile from your history
  (average/cluster the adjustments you actually apply) and have the agent suggest *"this looks like
  your Work profile — apply it?"*. v1 = explicit save + reapply; auto-inference is a later increment.

### 1.9 UI — clip inspector panel (new)

A right-side inspector that appears when a clip is selected (sits with `Preview`/`ChatPanel` in the
stage; see [`App.tsx:170`](../src/renderer/src/App.tsx)):

- **Color section:** sliders (exposure, contrast, saturation, temperature, tint, hue, gamma), a Reset
  button, and a small live note that preview is approximate / export is exact.
- **Presets gallery:** built-in looks + your saved profiles, one-click apply.
- **LUT:** load a `.cube` via file picker (copied into `<project>/luts/`, referenced relatively).
- **Save as brand profile…**
- (Bonus) host the existing UI-less `opacity`/`volume`/`fades` here too.

### 1.10 LUT handling

- Import a `.cube` → copy into `<project>/luts/` (mirrors how media is managed) and store a
  project-relative `lutRef`; the export resolver maps it to an absolute path for `lut3d`.
- Profile-attached LUTs live in the userData store (self-contained, portable across projects).

### 1.11 Tests (keep the green bar)

- `color.test.ts` — defaults, `colorIsIdentity`, `mergeColor`.
- `compositor.test.ts` — `VisualLayer.color` populated; identity when no grade.
- `exportGraph.test.ts` — graded clip emits correct `eq`/`hue`/`colortemperature`/`lut3d`; neutral clip
  emits **none**.
- `tools.test.ts` — `set_clip_color` validates + merges; `summarizeTimeline` includes color.
- `EditorController.test.ts` — `setClipColor` merge + undo/redo round-trip; JSON `load()` restores color.
- profiles store — save/list/delete (main, mocked fs).

### 1.12 Implementation order (each step ships green, core before UI — same discipline as P2–P6)

1. `color.ts` model + `Clip.color` + `colorAt` + tests.
2. Export filters (`exportGraph.ts`) + tests → **color renders** (drivable by agent/JSON before any UI).
3. Compositor + Preview `ctx.filter` → **color is visible live**.
4. `setClipColor` + `ClipPropertyEdit`/`EDITABLE_KEYS`.
5. `set_clip_color` + `apply_color_preset` + summarize → **AI control**, headless-testable.
6. Built-in presets catalog.
7. User profiles: main store + IPC + bridge + `list_color_profiles`.
8. UI inspector: sliders + presets + profiles + LUT picker.
9. LUT export (`lut3d`) + project copy + (v1.1) preview WebGL for exact LUT/temperature.

---

## 2. Phase 10 — AI colorization (B&W → color), deferred

Different shape from grading: it's **media processing that produces a new asset**, not a per-clip
filter. It reuses the P7 *"generate/process externally → import"* pattern.

- **Engine options:**
  - **A) Replicate API (BYOK)** — DeOldify / DDColor via Replicate. Fastest to integrate, no local
    weights; uploads footage (cost + privacy trade-off). **Recommended MVP.**
  - **B) Local ONNX** — DDColor/DeOldify ONNX run with `onnxruntime-node` in `main`: ffmpeg extracts
    frames → model colorizes → ffmpeg reassembles with the original audio. Private, no per-use cost,
    but heavy (weights download, GPU-ideal, slow on CPU). Offline option after A.
  - **C) Higgsfield/other** — only if it actually offers colorization (verify; the plan already warns
    upstream upscale is unconfirmed).
- **Host tool** `colorize_media({ sources | assetId, engine, intensity, renderFactor })` →
  host-executed like `import_media` → returns the new colorized `assetId` for `add_clip`.
- **UI:** "Colorize (AI)" on a bin asset / selected clip → progress → new asset in the bin.
- **Synergy with P9:** after colorizing, the agent can auto-apply one of your saved profiles
  (*"colorize this and grade it with my Work look"*) — chaining P10 → P9.

---

## 3. Open decisions before coding P9

1. **Preview fidelity:** ship v1 with Canvas `ctx.filter` (fast, approximate) and defer WebGL to v1.1,
   or go straight to WebGL for exact temperature/LUT in preview? (Recommend: Canvas first.)
2. **Inspector placement:** replace the chat column when a clip is selected, or a dedicated fourth
   pane / collapsible right rail? (Recommend: collapsible right rail so chat stays visible.)
3. **LUT scope in v1:** full-intensity `lut3d` only, or also partial `lutIntensity` (needs split+blend)?
   (Recommend: full-intensity v1, partial v1.1.)
4. **Default profile:** should a "default for new clips" profile auto-apply on `add_clip`, or stay a
   manual one-click? (Recommend: manual in v1 to avoid surprising the user.)
