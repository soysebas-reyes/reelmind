# Attribution & Credits

## This project is a derivative work

**Windows AI-Native Video Editor** is an independent, open-source derivative of
**Palmier Pro**, the AI-native video editor for macOS created by Palmier, Inc.

- **Upstream project:** [`palmier-io/palmier-pro`](https://github.com/palmier-io/palmier-pro)
- **Upstream copyright:** © 2026 Palmier, Inc.
- **Upstream license:** GNU General Public License v3.0 (GPL-3.0)
- **Upstream website:** https://palmier.io

We are deeply grateful to the Palmier team for releasing their work as open
source. This project would not exist without it.

## What this project is (and is not)

Palmier Pro is a **native macOS application written in Swift**, built on
Apple-only frameworks (AppKit/SwiftUI, AVFoundation, CoreML, Speech, Security,
Sparkle). It cannot run on Windows.

This project is a **new, cross-platform application (Electron + TypeScript +
React)** for **Windows**. It is **not a copy or a recompilation** of Palmier
Pro. The platform-locked layers (UI, video engine, on-device ML, transcription,
auto-update) are re-implemented from scratch using cross-platform technology
(FFmpeg, ONNX Runtime, whisper, etc.).

What it **does** carry forward from Palmier Pro — as a GPL-3.0 derivative — are
the *portable concepts and designs*:

- the timeline **data model** (tracks, clips, keyframes, frame-based time base);
- the pure **editing algorithms** (ripple, overwrite, snap, keyframe sampling);
- the **agent tool contract** (the set of LLM tools an AI uses to drive the editor);
- the **MCP integration** design (a loopback server exposing those tools to
  Claude Code / Cursor / Claude Desktop);
- the project/media manifest and FCP-XML interchange logic.

Per GPL-3.0, this project is **also licensed under GPL-3.0-or-later**, preserves
the upstream `LICENSE`, states its changes (see Git history and this file), and
publishes its source.

## Trademark / branding

"Palmier" and "Palmier Pro" are names/brands of Palmier, Inc. This project does
**not** use those names for its product and is **not affiliated with, sponsored
by, or endorsed by** Palmier, Inc. References to Palmier here are for attribution
only.

## Third-party components

These are credited here as they are integrated:

- **FFmpeg** — invoked as a separate process for media probing, preview proxies,
  and export. FFmpeg is distributed under its own license (LGPL/GPL depending on
  build); it is not statically linked into this application.
- **SigLIP 2** (Google/DeepMind) — Apache-2.0 — planned for the visual-search
  feature; model weights/conversion will retain their Apache-2.0 attribution.
- Open-source npm dependencies — see `package.json` and each package's license.
- Bundled fonts (if reused from upstream) — distributed under the SIL Open Font
  License (OFL); their license files are retained.
