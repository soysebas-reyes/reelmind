# ReelMind

**An open-source, AI-native video editor for Windows — you and your agent
generate and edit video together, right on the timeline.**

> ⚠️ **Status: early development.** Phases 0–1 done: the desktop app runs, imports
> media (video/audio/images) into a project, and saves/opens `.vproj` projects.
> Timeline editing, preview, export, the AI agent, and generation are coming phase
> by phase. **Full plan & state:** [`docs/PROJECT_PLAN.md`](docs/PROJECT_PLAN.md).

---

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

| Concern | Palmier Pro (macOS) | This project (Windows) |
| --- | --- | --- |
| UI | AppKit + SwiftUI | Electron + React + TypeScript |
| Video compose / preview / export | AVFoundation | FFmpeg + HTML5/Canvas preview |
| Visual search | CoreML (SigLIP2) | ONNX Runtime (planned) |
| Transcription | Speech framework | whisper.cpp / faster-whisper (planned) |
| Auto-update | Sparkle | Squirrel / WinSparkle (planned) |
| AI generation | Palmier cloud backend (credits) | Multi-provider, bring-your-own-key |

## Architecture (target)

- **Electron 3-context model.** *Main* (Node): project IO, FFmpeg/ffprobe,
  secrets via Windows `safeStorage`/DPAPI, the embedded MCP server, the agent
  runner. *Preload*: a narrow, context-isolated, sandboxed bridge. *Renderer*
  (React): UI, live editing state, and the pure engines (run at 60fps).
- **`EditorController` command API** — every edit is one named, undoable command.
  The UI, the in-app agent, and the MCP server all call the *same* commands.
- **Frame-based time** throughout (integers), matching upstream.
- **Preview** = pooled `<video>` + Canvas compositor (real-time); **export** =
  one FFmpeg `filter_complex` (exact). Both share one geometry/opacity/volume
  module so they stay consistent.
- **AI** = one tool contract (Zod → JSON Schema) + one executor, shared by two
  transports: the in-app agent (`@anthropic-ai/sdk`, BYOK) and the MCP server
  (`@modelcontextprotocol/sdk`). Bring-your-own-key only.
- **Generation** = a provider-agnostic adapter (Higgs Field first, then fal.ai /
  Replicate), with your own API keys.

## Roadmap

- **P0 — Repo + scaffold** ✅ _(this commit)_
- **P1 — Editor:** media import + bin (ffprobe, thumbnails, waveforms), project format
- **P2 — Editor:** timeline editing (trim / move / split / ripple / snap), undo/redo
- **P3 — Editor:** real-time multi-track preview
- **P4 — Editor:** FFmpeg export
- **P5 — AI:** agent tool contract + in-app chat (BYOK)
- **P6 — AI:** embedded MCP server (Claude Code / Cursor / Claude Desktop)
- **P7 — Generation:** Higgs Field (multi-provider adapter)
- **P8 — Generation + packaging:** fal.ai / Replicate, Windows installer

## Getting started (development)

**Prerequisites**

- Windows 10/11
- [Node.js](https://nodejs.org/) 20+ (developed on v24)
- [FFmpeg](https://ffmpeg.org/) 6+ on your `PATH` (developed on 8.0.1) — required
  from Phase 1 onward; the bundled binary will come later

**Run**

```bash
npm install      # install dependencies
npm run dev      # launch the app in development (hot reload)
npm run build    # production build into out/
npm run typecheck
npm test         # unit tests (vitest)
```

## License

[GPL-3.0-or-later](./LICENSE). As a derivative of GPL-3.0 software, this project
is and remains GPL-3.0; you may use, study, modify, and redistribute it under
those terms. See [`ATTRIBUTION.md`](./ATTRIBUTION.md) for upstream credit and
third-party notices.
