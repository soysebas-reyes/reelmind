# Reelo

**An open-source, AI-native video editor for Windows and macOS (Apple Silicon) —
you and your agent edit video together on the timeline. It doesn't replace CapCut
or Premiere; it does the technical, repetitive work fast and hands the result off
to them.**

> ⚠️ **Status: active development, early beta.** The desktop app runs and
> the core editor + AI + MCP are working: import, timeline editing, real-time
> preview, FFmpeg export (GPU-accelerated), colorization, multicam sync, audio
> enhancement, angle switching, script-based take segmentation, and an "export to
> Premiere / DaVinci / Final Cut / CapCut" handoff. Windows ships as an NSIS
> installer with auto-update; the macOS build (arm64, signed + notarized) comes
> out of the CI release pipeline. Some end-to-end flows (take detection, the NLE +
> CapCut handoff) are implemented and unit/integration-tested but still pending
> verification on real footage / in a real NLE / in real CapCut. AI media
> **generation** is next. **Full plan & state:** [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

---

## What it does today

Reelo focuses on the technical, repeatable parts of an editing job so a human
(or an agent) can move fast, then hands a clean, still-editable project to a
finishing editor:

- **Import** video/audio/images from files, folders, or URLs (direct links, and
  platform links — YouTube/Instagram/TikTok/… — via `yt-dlp`).
- **Multicam sync** — align two angles of the same take by audio
  cross-correlation, tag them as a linked group.
- **Angle switching** — cut between synced angles (non-destructive or ripple).
- **Colorization** — per-clip color grade + `.cube` LUTs, live in the WebGL
  preview and baked exactly on export.
- **Audio enhancement** — non-destructive voice cleanup / loudness chain (Web
  Audio live, FFmpeg on export).
- **Segment by scripts ("guiones")** — paste your scripts; it transcribes, aligns
  each script to where it was recorded, and opens each take as a clean, editable
  tab.
- **Timeline editing** — trim / move / split / ripple / snap, keyframes,
  transform, crop, opacity, fades, undo/redo.
- **Export** — one flat MP4 (FFmpeg), **or** a handoff to a finishing editor (see
  below).

### Handoff to a finishing editor (Premiere / DaVinci Resolve / Final Cut / CapCut)

Subtitles and effects aren't Reelo's job — they're the editor's. So instead of
only rendering a flat MP4, the **"Enviar a editor"** button writes an **editable
project** the editor opens in their **NLE** (*Non-Linear Editor* — Premiere Pro,
DaVinci Resolve, Final Cut) **or in CapCut**:

- A **Final Cut Pro 7 XML** (`xmeml`) sequence — the one interchange format
  Premiere / DaVinci / Final Cut all import reliably — **or** a **CapCut draft
  folder** (`draft_content.json` + `draft_meta_info.json`) CapCut opens directly.
- **Baked media** with our color grade + audio enhancement already in the
  pixels/audio, but with clips still **separate and re-editable** — so the editor
  keeps your look and just adds titles/effects/transitions.

The xmeml handoff lands in a `handoff/<project>-<timestamp>/` folder (`.xml` +
`media/` + `luts/` + a README with per-NLE import steps). The CapCut draft lands
straight in CapCut's draft folder when it's detected (so it shows up in CapCut with
no manual step), otherwise in the folder you pick with move instructions.

## Drive it from Claude Code (MCP)

Reelo embeds an **MCP** server, so an external agent (**Claude Code**, Cursor,
Claude Desktop) can operate the editor with the *same* command surface a human
uses — in natural language: *"load this folder, download these videos, sync the
angles, colorize, segment by my scripts, export to Premiere."*

```sh
# with the app open:
claude mcp add --transport http reelo http://127.0.0.1:4399/mcp
```

Full tool list, the workflow, and setup: [`MCP.md`](./MCP.md).

## Credit where it's due

This is an **independent, cross-platform derivative** of
[**Palmier Pro**](https://github.com/palmier-io/palmier-pro) — the AI-native
video editor for macOS by [Palmier, Inc.](https://palmier.io), released under
GPL-3.0. Palmier Pro is a native macOS/Swift app and cannot run on Windows; this
project rebuilds the platform-locked parts on cross-platform technology while
carrying forward Palmier's "built for AI" design.

Huge thanks to the Palmier team. See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for the
full statement of what is reused and what is re-implemented. This project is
**not affiliated with or endorsed by Palmier, Inc.** and does not use the
"Palmier" name for its product.

## Vision

The core idea, inherited from Palmier Pro: an AI agent should be a first-class
operator of a real, non-linear video editor — not a chatbot beside it. The agent
can read the timeline, cut filler words, add captions, place clips, and generate
new media, using the **same command surface** a human uses. External tools like
**Claude Code** and **Cursor** drive it over **MCP**.

## Why a separate project (not a fork)

Palmier Pro is ~99% Swift on Apple-only frameworks (AppKit/SwiftUI, AVFoundation,
CoreML, Speech, Sparkle). A Windows version is effectively a rewrite, so this is
an independent repository — with full attribution — rather than a fork. The
high-value, portable parts (data model, editing algorithms, the AI tool
contract, the MCP design) are re-implemented in TypeScript.

| Concern | Palmier Pro (macOS) | This project (Windows + macOS) |
| --- | --- | --- |
| UI | AppKit + SwiftUI | Electron + React + TypeScript |
| Video compose / preview / export | AVFoundation | FFmpeg + HTML5/Canvas preview |
| Visual search | CoreML (SigLIP2) | ONNX Runtime (planned) |
| Transcription | Speech framework | ElevenLabs Scribe (cloud, BYOK) |
| Auto-update | Sparkle | electron-updater (GitHub Releases) |
| AI generation | Palmier cloud backend (credits) | Multi-provider, bring-your-own-key (planned) |

## Architecture

- **Electron 3-context model.** *Main* (Node): project IO, FFmpeg/ffprobe,
  secrets via `safeStorage` (DPAPI on Windows, Keychain on macOS), the embedded
  MCP server, the agent runner. *Preload*: a narrow, context-isolated, sandboxed
  bridge. *Renderer* (React): UI, live editing state, and the pure engines.
- **`EditorController` command API** — every edit is one named, undoable command.
  The UI, the in-app agent, and the MCP server all call the *same* commands.
- **Frame-based time** throughout (integers), matching upstream — which also
  makes the FCP7-XML handoff map 1:1 with no rounding.
- **Preview** = pooled `<video>` + Canvas compositor (real-time); **export** =
  one FFmpeg `filter_complex` (exact). Both share one geometry/opacity/color/
  volume module so they stay consistent.
- **AI** = one tool contract (Zod → JSON Schema) + one executor, shared by two
  transports: the in-app agent (`@anthropic-ai/sdk`, BYOK) and the MCP server
  (`@modelcontextprotocol/sdk`). Bring-your-own-key only.
- **Interchange** = a pure `src/core/interchange/` builder (FCP7 xmeml) + a bake
  planner, orchestrated in main to produce editable media for the handoff.

## Roadmap

Done:

- **P0 — Repo + scaffold** ✅
- **P1 — Media import + bin** (ffprobe, thumbnails, waveforms), `.vproj` format ✅
- **P2 — Timeline editing** (trim / move / split / ripple / snap, keyframes, undo/redo) ✅
- **P3 — Real-time multi-track preview** ✅
- **P4 — FFmpeg export** ✅
- **P5 — AI agent tool contract + in-app chat** (BYOK) ✅
- **P6 — Embedded MCP server** (Claude Code / Cursor / Claude Desktop) ✅
- **Colorization** — per-clip grade + LUTs, live + export ✅
- **Multicam sync + angle switching** ✅
- **Audio enhancement** (voice cleanup / loudness) ✅
- **Segment by scripts** (transcription + take tabs) ✅ *(pending on-footage E2E)*
- **NLE handoff** (FCP7 XML + baked media → Premiere / Resolve / FCP) ✅ *(pending real-NLE verification)*
- **CapCut handoff** (CapCut draft JSON + baked media, auto-placed in CapCut's draft folder) ✅ *(pending real-CapCut verification)*

Next:

- **Generation** — Higgs Field, then fal.ai / Replicate (multi-provider, BYOK)

## Install

### Windows

1. Download `Reelo-<version>-setup.exe` from the latest
   [GitHub Release](https://github.com/soysebas-reyes/reelo/releases).
2. Windows SmartScreen will warn about an unknown publisher (the installer is not
   code-signed yet): click **More info → Run anyway**.
3. Follow the installer (per-user install, no admin needed). FFmpeg ships inside —
   no separate install required.

### macOS (Apple Silicon)

1. Download `Reelo-<version>-arm64.dmg` from the latest
   [GitHub Release](https://github.com/soysebas-reyes/reelo/releases).
2. Open the dmg and drag **Reelo** into **Applications**. The app is signed and
   notarized, so Gatekeeper opens it normally. FFmpeg ships inside.

### First launch (both platforms)

- Set your API keys in **Ajustes → Claves API** (both optional, bring-your-own-key,
  stored encrypted on your machine — DPAPI on Windows, Keychain on macOS):
  - **Anthropic (Claude)** — the AI editing chat and script segmentation.
  - **ElevenLabs** — transcription, transcript-aware silence cutting, voice isolation.
- Optional: install [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) (`brew install yt-dlp`
  on macOS) and have it on your `PATH` to import from YouTube/Instagram/TikTok links.

The app updates itself from GitHub Releases. Local usage measurement (never content)
can be turned off in **Ajustes → Privacidad**. To release a new version, see
[`docs/RELEASE.md`](./docs/RELEASE.md).

**Known limitation:** projects reference *external* media (files not consolidated
into the `.vproj` package) by absolute path, so a project moved to another machine
or OS needs its external media relinked; consolidated media and proxies travel fine.

## Getting started (development)

**Prerequisites**

- Windows 10/11 or macOS on Apple Silicon
- [Node.js](https://nodejs.org/) 20+ (developed on v24)
- [FFmpeg](https://ffmpeg.org/) 6+ on your `PATH` (developed on 8.0.1) — the
  bundled binary ships with packaging (`npm run fetch:ffmpeg`)
- Optional: [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your `PATH` to import
  from YouTube/Instagram/TikTok/… links
- Optional keys (bring-your-own), set in **Ajustes → Claves API** (or, in dev,
  `ELEVENLABS_API_KEY` via `.env` — see `.env.example`): Anthropic for the agent,
  ElevenLabs for transcription

**Run**

```bash
npm install      # install dependencies
npm run dev      # launch the app in development (hot reload)
npm run build    # production build into out/
npm run typecheck
npm test         # unit + integration tests (vitest)
```

## License

[GPL-3.0-or-later](./LICENSE). As a derivative of GPL-3.0 software, this project
is and remains GPL-3.0; you may use, study, modify, and redistribute it under
those terms. See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for upstream credit and
third-party notices.
