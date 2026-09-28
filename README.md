# MuseReader

A simple React + TypeScript app for uploading PDFs and annotating them with [react-pdf-highlighter-plus](https://www.npmjs.com/package/react-pdf-highlighter-plus).

## Features

- Upload a local PDF file
- Select text to highlight and attach a comment
- **Highlight** mode (left rail) highlights every selection straight away in
  the chosen color/style — click the active Highlight button to change them
- Hold **Alt** and drag (or pick **Area highlight**) for rectangular highlights
- Pick **Sticky note** (or right-click the page) to place an editable note
- **⌘Z** undoes adding, editing or deleting a highlight or note; **Esc**
  returns to plain text selection
- Search panel (**⌘F**) listing every match in the document
- Sidebar listing all annotations with jump-to and delete
- **View** menu (bottom of the rail) for zoom (**⌘+ / ⌘− / ⌘0**), two-page
  view, continuous scrolling, collapsing sticky notes, and theme
- Annotations persist in `localStorage` per uploaded file
- Export an annotated copy of the PDF

## Setup

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (usually `http://localhost:5173`).

### Desktop app (Tauri)

MuseReader also ships as a native desktop app for macOS, Windows, and Linux via
[Tauri](https://tauri.app). This requires the [Rust toolchain](https://www.rust-lang.org/tools/install)
in addition to Node.js.

```bash
npm run tauri dev    # launch a native window against the Vite dev server
npm run tauri build  # produce an installable app bundle (dist/, target/release, etc.)
```

In the packaged desktop build, Tauri spawns the Deep Dive API server (`server/`,
bundled by `npm run build:server`) as a child process using the system Node.js
install. By default it shells out to the `claude` CLI, which must be installed
and logged in on the machine running the app, same as in dev — see
[Deep Dive providers](#deep-dive-providers) for using a hosted API instead.

## Deep Dive providers

Deep Dive's "dive" (main panel) and "quick" (one-tap glossary) roles can each
run through a different LLM provider — copy `.env.example` to `.env` in this
directory and set `DIVE_PROVIDER`/`DIVE_MODEL` and/or
`QUICK_PROVIDER`/`QUICK_MODEL`. Supported providers: `anthropic-cli` (the
default — local `claude` CLI, no API key), `anthropic`, `openai`, `google`,
and `muse-spark` (Meta, via the OpenAI SDK pointed at Meta's endpoint), each
needing its own `*_API_KEY` in `.env`. See `.env.example` for details.

`openai` and `muse-spark` both go through the official `openai` SDK — any
other OpenAI-Chat-Completions-compatible host (Groq, Together, Fireworks, ...)
can be added the same way `server/providers/museSpark.js` wraps
`server/providers/openAiCompatible.js` with its own base URL.

## Usage

1. Click **Choose PDF file** and select a PDF.
2. Select text in the document — a popup lets you add a comment and save the highlight.
3. Use toolbar buttons for area highlights or sticky notes.
4. Click an item in the sidebar to scroll to that annotation.
5. Click **Export PDF** to download a flattened annotated copy.

## Scripts

- `npm run dev` — start the dev server
- `npm run build` — type-check and build for production
- `npm run build:server` — bundle the Express server for the desktop build (run automatically by `npm run tauri build`)
- `npm run preview` — preview the production build
- `npm run tauri dev` / `npm run tauri build` — run or package the Tauri desktop app
