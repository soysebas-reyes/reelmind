# Reelo — Color Grading & Colorization Plan (P9 + P10)

> Companion to [`PROJECT_PLAN.md`](./PROJECT_PLAN.md). Two phases:
> **P9 — manual color grading** (per-clip adjustments, look presets, `.cube` LUTs, AI control,
> and **reusable saved color profiles** like *"Personal brand"* / *"Work"*), then
> **Phase 9.5 — Colorization Explorer** (a UI to tweak every parameter, one-click *recommended
> configs*, an exact per-shot preview, save/compare *muestras* vs the raw, and **"Elegir"** one look
> for the whole video — see [§ Phase 9.5](#phase-95--colorization-explorer)), then
> **P10 — AI colorization** (B&W → color), deferred to a later pass.

---

## 0. Why this fits Reelo cleanly

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
  // Tonal regions (Lumetri Resaltados/Sombras/Blancos/Negros) — required by the Phase 9.5 document
  // presets; stored on Lumetri's native -100..100 scale so preset values match the source PDF verbatim.
  highlights: number   // -100..100        (0)
  shadows: number      // -100..100        (0)
  whites: number       // -100..100        (0)
  blacks: number       // -100..100        (0)
  lutRef?: string      // project-relative path or profile LUT id (optional)
  lutIntensity?: number // 0..1            (1)
}

export function makeColorAdjustments(p?: Partial<ColorAdjustments>): ColorAdjustments
export function colorIsIdentity(c: ColorAdjustments): boolean   // all 12 numeric fields neutral AND no active LUT → skip all filters
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
| highlights/shadows/whites/blacks | one `curves=all='0/<blacks> 0.25/<shadows> 0.75/<highlights> 1/<whites>'` (Lumetri tone regions) |
| LUT | `lut3d=file='<resolved .cube>':interp=tetrahedral`; **intensity<1 via `split`+`blend=all_opacity=<intensity>` — ships in v1** (the Phase 9.5 document presets all use 50%) |

> **Order — matches Lumetri "LUT as base, then grade":** apply `lut3d` **first**, then `eq` →
> `colortemperature` → `colorbalance` → `curves`; wrap the LUT in the `split`+`blend` when
> `lutIntensity < 1`. (Confirm LUT-first vs WB-first empirically against the reference stills.)

This is the only place exact color lands; covered by `exportGraph.test.ts` assertions on the emitted
`filter_complex`. Extract the chain builder as `buildColorFilterChain(color, resolveLut)` so the
Phase 9.5 still preview (`generateStillWithColor`) reuses it verbatim → **preview == export**.

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

This is the part you specifically asked for: Reelo should **remember named, reusable looks** (e.g.
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

## Phase 9.5 — Colorization Explorer

> Productizes the manual Premiere/Lumetri + `.cube` loop for talking-head reels, built directly on
> P9's model / compositor / export / tool seams. The end-to-end loop:
> **tweak every parameter → one-click load a recommended config → see an *exact* preview of a shot →
> save several *muestras* → compare them against the RAW → "Elegir" one look → apply to the whole video.**

> **⚠️ Status (2026-06-23) — shipped on branch `feat/p95-colorization-core`, NOT merged.** The headless
> core (model, export chain, presets, LUT resolver, still) **and** the renderer UI (modal Explorer with
> resizable panels, exact still preview, recommended presets, `set_clip_color` tool) are implemented and
> unit-tested. **Live-playback LUT (§9.5.12) — SHIPPED:** WebGL2 per-layer color pass (`colorGL.ts`)
> samples the 3D `.cube` as a GPU texture and applies the full grade live (LUT → intensity blend →
> eq → hue → colorbalance → curves), matching export order exactly. Pending on-device visual confirmation.
> **Multicam audio sync (§9.5.13) — SHIPPED:** pure-DSP cross-correlation offset recovery (`audioSync.ts`),
> FFmpeg PCM decode bridge, store actions + confirmation modal. **Project auto-settings** (resolution/fps
> auto-adopted from first imported video) also landed.

### 9.5.1 Goal & origin

This is the in-app version of a loop we first ran by hand with FFmpeg (raw vs LUT V.1/V.2, LUT-intensity
sweeps, skin variants). The colorist's source of truth is a client document (*"Guía de Parámetros de
Colorización"*) listing per-shot **LUT + Lumetri** settings. The Explorer makes those configs one click
away, lets the user fine-tune each parameter, compare candidate looks side-by-side against the raw, and
commit one look to the whole video — without round-tripping through Premiere.

### 9.5.2 Recommended-config presets — `src/core/color/presets.ts`

```ts
export interface ColorPreset {
  id: string                 // 'guillermo-frontal-v1'
  name: string               // 'Guillermo · Frontal · V.1'
  group?: string             // 'Primeros Reels (1–3)' | 'Segundos Reels (4–16)'
  cameraAngle?: 'frontal' | 'lateral'
  color: ColorAdjustments    // full values incl. lutRef + lutIntensity
  source?: string            // provenance shown in UI, e.g. 'Guía de Parámetros de Colorización'
  builtin: true
}
```

- Ship the **four document configs as preset definitions** (values only — see table; LUT binaries are
  *not* bundled, see §9.5.3), plus the generic looks from §1.7 (`warm`, `cool`, `teal-orange`, …).
- **One-click "Cargar configuración recomendada"** loads `preset.color` wholesale into the panel's
  *working draft* (no commit until "Guardar muestra" or "Elegir"). Internally the same `setClipColor`
  merge path; a document preset replaces, a generic look merges.

Document preset values (verbatim from the source PDF; saturation stored as `lumetri/100`, contrast as
`1 + lumetri/100`):

| Preset id | LUT | Int | Temp | Tint | Sat | Exp | Contr | Highl | Shad | White | Black |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `guillermo-frontal-v1` | Frontal V.1 | 0.5 | −7.4 | 4.0 | 0.88 | 0 | −21.1 | 0 | 8.6 | 0 | 0 |
| `guillermo-lateral-v1` | Lateral V.1 | 0.5 | −14.3 | 7.4 | 0.88 | 0.3 | −29.1 | 0 | −2.9 | 33.7 | 0.6 |
| `guillermo-frontal-v2` | Frontal V.2 | 0.5 | 0 | 0 | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 |
| `guillermo-lateral-v2` | Lateral V.2 | 0.5 | 0 | 0 | 1.0 | 0 | 0 | 0 | 0 | 0 | 0 |

(The V.2 look is carried entirely by its LUT. The non-tonal Lumetri values here are the verified
panel readings.)

### 9.5.3 Confidential LUT handling — do **not** commit

The "Color Guillermo" `.cube` files are **client-confidential** and must never enter this public
GPL-3.0 repo.

- Preset **definitions** live in code; the **`.cube` binaries are never committed**.
- **First build step:** add `Guia_Colorizacion/` and `**/luts/*.cube` to `.gitignore` (the folder is
  currently *untracked* — protect it from an accidental `git add`).
- LUT resolver `resolveLut(lutRef, { projectDir }): string | null` resolves in order: project
  `<project>/luts/` → app `userData/luts/` (saved profiles) → a **user-configured "preset LUT library"
  folder** (default: the local `Guia_Colorizacion/`; path persisted in a small `userData` app-settings
  JSON, same pattern as [`secrets.ts`](../src/main/ai/secrets.ts)). Document presets use
  `lutRef: 'preset:guillermo-frontal-v1'`.
- **Graceful miss:** if a preset's LUT is not found, load its Lumetri params, **skip the `lut3d` step**,
  and show a badge *"LUT no encontrada — ubícala"* with a "Seleccionar carpeta de LUTs…" action. Never
  crash; never silently no-op the whole grade.

### 9.5.4 Sample / compare / choose — data model & workflow

```ts
export interface ColorSample {
  id: string
  name: string               // 'Muestra 1' or user-named
  color: ColorAdjustments    // full snapshot of the panel at save time
  sourceClipId?: string      // the shot previewed
  refFrame: number           // timeline frame the still is taken at
  presetId?: string          // provenance, if derived from a recommended config
  createdAt: string
}
```

- **Persistence:** add `colorSamples?: ColorSample[]` to the `Timeline` so it rides existing
  `.vproj/timeline.json` save/load (no `projectStore.ts` change). Samples are a **per-project working
  set**; a chosen sample can be **promoted to an app-level profile** (§1.8) for cross-project reuse.
- **Exact preview:** add `generateStillWithColor(filePath, seekSeconds, color, size)` to
  [`thumbnail.ts`](../src/main/ffmpeg/thumbnail.ts), built from the **shared `buildColorFilterChain`**
  (§1.4) so the preview matches the export exactly (real `lut3d`). Expose via IPC `color:still` +
  preload bridge. The Canvas `ctx.filter` path (§1.3) stays as the instant-but-approximate drag preview.
- **"Guardar muestra":** snapshot the working `color` + `sourceClipId` + `refFrame` into `colorSamples`.
- **Comparison gallery (core deliverable):** render each saved sample **+ the RAW** (`IDENTITY_COLOR`)
  on the **same reference frame of the same shot** — the document's *"Referencia | Actual"* layout
  generalized to N + RAW. Optionally also show the client reference PNG as a fixed target tile. **Cache**
  stills by `hash(mediaRef + refFrame + size + colorHash)` (session `Map`); RAW and unchanged samples
  never re-render.
- **"Elegir":** apply the selected sample's look to the whole video (§9.5.5).

### 9.5.5 "Elegir" — apply a look to the whole video

- One undo step over all visual clips:
  `runAs('user', () => transact('Aplicar look a todo', () => { for each video clip → setClipColor(clip.id, chosen.color) }))`.
  Pass the **full** `ColorAdjustments` so every field is deterministic; skip audio/text.
- Set `ProjectMeta.defaultColor?: ColorAdjustments` (in [`shared/ipc.ts`](../src/shared/ipc.ts) meta) so
  new `add_clip`s inherit it — auto-apply per resolved §3 #4, with a UI toggle.
- **Per-shot Exposure** stays live on the *selected* clip after a global look (the PDF's sanctioned
  per-shot knob for lean-in/out): `setClipColor(clipId, { exposure })` merges one field.
- **Multi-angle future (flag, don't build v1):** v1 applies one look to all. Near-term: *"Elegir para
  clips seleccionados"* (select all Frontal → Frontal V.1, etc.). Later: a per-clip
  `shotTag?: 'frontal' | 'lateral'` + per-tag defaults + `apply_look_to_all({ tag })`.

### 9.5.6 AI / MCP tools (extends §1.6; all core / headless-testable)

| Tool | Input → effect |
|---|---|
| `set_clip_color` | `{ clipId, exposure?, contrast?, saturation?, temperature?, tint?, hue?, gamma?, brightness?, highlights?, shadows?, whites?, blacks?, lutIntensity? }` → `setClipColor` (merge) |
| `apply_color_preset` | `{ clipId? \| clipIds?, preset }` — builtin look, **document preset id** (`guillermo-frontal-v1`…), or saved profile name |
| `list_color_profiles` | `{}` → builtin looks + document presets + saved user profiles |
| `apply_look_to_all` | `{ color? \| presetId? \| sampleId?, scope?: 'all' \| 'selected' }` — the agent's "Elegir" |
| `save_color_sample` | `{ name?, clipId?, refFrame? }` → snapshot into a `ColorSample` |
| `set_project_default_color` | `{ color? \| presetId? }` → set `meta.defaultColor` |

Add `color` to `summarizeTimeline` so the agent can see/report current grades. Composes with P11 recipes
(*"import folder → quitar silencios → aplicar Frontal V.1 → exportar"*).

### 9.5.7 Preview performance

Two tiers: **Canvas `ctx.filter`** for instant drag feedback (approximate, no LUT — label *"aprox;
exacto al exportar"*); **debounced (~250 ms) `generateStillWithColor`** for committed values, samples,
and the gallery (exact). Render stills at panel size (480–640 px), `scale` **before** `lut3d`; never at
source 4K. One still cache shared by the slider preview and the gallery.

### 9.5.8 UI mount

A collapsible **right rail with `AI | Color` tabs** so chat stays available (resolves §3 #2). New
`src/renderer/src/inspector/ColorInspector.tsx`: param sliders + Reset, recommended-config gallery
(one-click load), reference-frame picker, "Guardar muestra", comparison gallery (samples + RAW +
optional reference PNG), and "Elegir". UI conventions: plain CSS using existing `App.css` vars, native
`<input type="range">` / `<input type="number">` (no slider component exists yet — net-new).

### 9.5.9 Implementation order (each step ships green; core before UI)

1. `.gitignore` the client LUTs (safety first — §9.5.3).
2. **Model:** extend `ColorAdjustments` (+4 tonal), `colorAt`, `Clip.color`, helpers + `color.test.ts`.
3. **Export:** `buildColorFilterChain` + wire into `exportGraph` (+ intensity split/blend) +
   `exportGraph.test.ts` → **color renders exactly** (drivable by agent/JSON before any UI).
4. **Controller:** `setClipColor` (merge) + `color` in `EDITABLE_KEYS` / `ClipPropertyEdit` + undo test.
5. **AI tools:** the six tools + `summarizeTimeline` color + `tools.test.ts` → **agent can grade**.
6. **Presets:** `presets.ts` (4 document presets + generic looks) + `resolveLut` + `presets.test.ts`.
7. **Exact still:** `generateStillWithColor` + `color:still` IPC + preload + still cache.
8. **Approx preview:** `ColorAdjustments` → `ctx.filter` in `Preview.tsx`.
9. **Explorer UI:** right-rail tabs; param panel; recommended-config load; reference-frame picker;
   Guardar muestra; comparison gallery + RAW; Elegir.
10. **Project default** + apply-to-all UI; per-shot exposure override.
11. **(v1.1)** WebGL preview for exact live LUT/temperature; per-angle tagging.

### 9.5.10 Tests

`color.test.ts`; `exportGraph.test.ts` (ordered chain, intensity blend, neutral-emits-nothing,
`guillermo-frontal-v1` → `saturation=0.88` / `contrast≈0.789` / curves shadows lifted);
`EditorController.test.ts` (`setClipColor` merge + undo + JSON restore of `color`); `tools.test.ts`
(the six tools + summarize); `presets.test.ts` (document-preset id → exact values; resolver order +
graceful miss); **still-chain parity** (`generateStillWithColor` == `exportGraph` chain for a given
color); `colorSample` round-trip through timeline JSON.

### 9.5.11 Risks / edge cases

- **`.look` ≠ `.cube`.** `lut3d` reads `.cube`/`.3dl`/`.dat`, not Premiere `.look` (XML) — validate on
  import and reject with a clear message ("convert to .cube"), don't silently no-op.
- **Missing LUT** → render the rest of the chain + warn (§9.5.3), never crash.
- **Identity optimization** gates *all* color-filter emission so un-graded projects render byte-identical
  at zero cost (`colorIsIdentity`).
- **Preview ≠ export fidelity** for WB/tone/LUT in the Canvas path — disclosed in UI; the exact still is
  one debounce away so the user never ships on a wrong approximation.
- **Lumetri↔FFmpeg constants** (temperature Kelvin offset, exposure→brightness factor, `curves` control
  points) are approximations — calibrate against the reference stills and lock with golden tests; the
  LUT carries the dominant look, so small WB drift is cosmetic.
- **Saturation foot-gun:** Lumetri 100 = neutral → model `1.0` (range 0..2). Centralize the `/100`
  conversion in `presets.ts` and test it (a raw `88` in the model would mean 88× saturation).

### 9.5.12 ✅ RESOLVED (implementation) — live playback now shows the LUT (WebGL preview)

**Fix shipped (2026-06-21):** chose **option 1 (WebGL)**. A WebGL2 per-layer color stage
([`src/renderer/src/preview/colorGL.ts`](../src/renderer/src/preview/colorGL.ts)) samples the resolved
`.cube` as a 3D texture and applies the full grade in a fragment shader, in the **same order as the
export** (LUT → intensity blend → eq → hue → colorbalance → curves), reusing the export's calibration
constants (now exported from [`colorFilters.ts`](../src/core/export/colorFilters.ts)). `Preview.tsx`'s
`draw()` routes graded video/image layers through it (`ctx.drawImage(glCanvas, …)` inside the existing
transform/opacity/rotation save-block — **the 2D compositor, master-clock, and audio paths are
untouched**), falling back to the Canvas-2D CSS approximation only when un-graded or WebGL2 is
unavailable. The redundant paused FFmpeg-still overlay was removed (WebGL now shows the LUT paused
*and* playing; the Explorer keeps its own exact FFmpeg still as the decision reference).

- **LUT delivery:** new pure parser `parseCubeLut` ([`core/color/lut.ts`](../src/core/color/lut.ts),
  unit-tested incl. the real 65³ client LUT) + IPC `color:lutData` (main resolves via the same
  `resolveLut` order as `color:still`, parses, returns grid data; renderer caches per `lutRef`, uploads
  once, retries a miss after 3 s so configuring the LUT folder mid-session self-heals).
- **Fidelity:** LUT is trilinear (hardware) vs FFmpeg tetrahedral — cosmetically identical for these
  film LUTs; WB/tone use the same approximate constants as the still/export, so preview ≈ still ≈ export.
- **Verified headless:** typecheck (node+web), 215 tests, production build all green; real client `.cube`
  (65³) parses to a normalized 0..1 grid. **Pending: on-device visual confirmation** that pressing Play
  shows the graded look, and a re-check of play/pause/resume sync.

<details>
<summary>Original bug report &amp; options considered (kept for history)</summary>

**Symptom (user-reported, 2026-06-21):** after "Elegir", the *paused* preview frame is correctly graded
(LUT included), but **pressing Play shows the clip ungraded** — the whole video plays without the look.

**Root cause — two different preview paths:**
- *Paused* → `generateStillWithColor` (FFmpeg, exact, incl. `lut3d`) overlaid on the canvas
  ([`Preview.tsx`](../src/renderer/src/preview/Preview.tsx), the `exactUrl` effect). ✅ shows the LUT.
- *Playing* → Canvas-2D `ctx.filter` (`colorToCanvasFilter` in `Preview.tsx`), which only does
  brightness/contrast/saturation/hue and **cannot sample a 3D `.cube` LUT**. ❌ no LUT. Because the
  Guillermo looks are LUT-dominant, live playback looks essentially uncolorized.

This is **not a data bug**: `set_clip_color` correctly stores the grade on every clip and the FFmpeg
**export is exact**. It is a **preview-fidelity gap during playback**.

**Options to investigate next session (pick one):**
1. **WebGL preview compositor (recommended; was the v1.1 note in §1.3).** Render the live preview in
   WebGL and sample the loaded `.cube` as a 3D texture in a fragment shader (plus temperature/tonal/
   intensity-blend) → exact, WYSIWYG live playback. Biggest correctness win; medium lift.
2. **Graded proxy on "Elegir".** Render a low-res graded proxy via FFmpeg (full color chain) and play
   THAT in the preview instead of the raw source. Exact playback, no shader work, but adds a render
   step + temp-file lifecycle + invalidation whenever the grade changes.
3. **Status quo + honest labeling.** Keep approximate-while-playing / exact-when-paused / exact-export
   and label the transport. Lowest effort; does NOT satisfy "watch the colorized video play".

**Recommendation:** option 1 (WebGL) for a true live preview; option 2 if WebGL is too costly.
Also re-verify the play/pause/resume **video-as-master-clock** fix once the preview path changes.

</details>

### 9.5.13 ✅ SHIPPED — Multicam audio sync

**Shipped 2026-06-23** on `feat/p95-colorization-core`.

Recovers the time offset between two camera angles by cross-correlating their short-time RMS energy
envelopes (no FFT, no dependencies — bounded direct cross-correlation is cheap enough since both
cameras film the same take).

- **`src/core/edit/audioSync.ts`** — pure DSP (Electron-free): `rmsEnvelope`, `crossCorrelateOffset`,
  `lagToSeconds`, `SYNC_MIN_CONFIDENCE`, `SYNC_MIN_MARGIN`. Tested in `audioSync.test.ts`.
- **`src/main/ffmpeg/audioSync.ts`** — FFmpeg bridge: decodes each source to 8 kHz mono PCM
  (only loudness-over-time matters → 8 kHz is enough), calls the DSP core, returns `{ offsetSeconds,
  confidence }`. `extractAudio` utility for standalone audio extraction.
- **`store.ts`** — `SyncResultState`, `syncClips(clipIdA, clipIdB)` action (triggers IPC, opens
  confirmation modal with offset + confidence), `confirmSync` (shifts clip B by the recovered offset).
- **`tools.ts`** — `sync_clips` AI tool so the agent can sync two angles by name.
- **`App.tsx`** — `SyncConfirmModal` component; shows offset in seconds + frames and confidence %.

**Pending on-device verification:** run with two real dual-camera clips to confirm the offset
recovery is accurate and the modal flow end-to-end is correct.

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

## 3. Open decisions / next steps

All pre-coding P9 decisions are resolved. The branch `feat/p95-colorization-core` is feature-complete
for the core loop. Remaining work before merge:

1. **On-device visual confirmation** — press Play with a graded clip and verify the LUT renders live
   (§9.5.12). Re-check play/pause/resume sync didn't regress.
2. **Multicam sync end-to-end** — run `sync_clips` with two real dual-camera clips; verify offset
   accuracy and modal flow (§9.5.13).
3. **Export with color smoke test** — export a short clip with a document preset; compare to the
   Explorer still to confirm preview ≈ export.
4. **Merge to `main`** — once the above are green.
5. **Future improvements** (to propose in next session):
   - Per-angle tagging (`shotTag: 'frontal' | 'lateral'`) + bulk apply by tag (§9.5.5 multi-angle note)
   - Auto-learn color profile from grade history (§1.8 roadmap note)
   - `(v1.1)` WebGL temperature matrix (currently approximated — cosmetic for LUT-dominant looks)
   - P10 AI colorization (B&W → color, deferred — §2)
