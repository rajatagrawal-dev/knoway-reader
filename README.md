# Knoway Reader

Knoway Reader is a PDF and EPUB reader for studying dense documents: textbooks,
papers, lecture notes. It does everything you'd expect for highlighting and
note-taking, and adds an AI study layer. You can select a passage and "deep
dive" into it, ask questions about the whole document, and build a glossary of
its terms and notation. Answers are grounded in the document itself and cite
the pages they draw on.

It runs in the browser or as a native desktop app via [Tauri](https://tauri.app).
So far it has only been tested on macOS. Tauri can also build it for Windows
and Linux, but those builds haven't been tried yet.

## Features

### Library
- Import PDFs and EPUBs (**⌘O**). Each one's title, author, page count and
  cover are read from the file, and importing the same file twice opens the
  existing entry.
- An EPUB becomes a PDF when it's added: the browser lays it out (using the
  book's own stylesheets) as a 6×9in paperback set in Literata. The result has real
  text, the book's pictures, working links, and its table of contents as
  bookmarks. Every feature below then works on it the same way it does on a PDF.
  Known gaps: CJK text and emoji aren't drawn (the bundled fonts don't cover
  them), small caps come out as ordinary letters, and right-to-left scripts
  aren't laid out right to left.
- "Continue reading" brings you back to where you left off.
- Export and import all your notes as a single backup file.

### Reading and annotating
- Text highlights with comments. **Highlight** mode highlights each selection
  as you make it, in the color and style you choose.
- Area highlights (hold **Alt** and drag) and sticky notes (right-click the page).
- **⌘Z** undoes adding, editing or deleting a highlight or note.
- Table of contents, full-text search (**⌘F**) and an annotations sidebar.
- Page navigator with typed page numbers (printed labels like "xii" work) and
  **Back / Forward** (**⌘← / ⌘→**) over every jump.
- Zoom, two-page view, continuous scrolling, and light/dark themes.
- Cross-references: "Eq. (3.2)", "Theorem 4.1", "Fig. 7" and "[12]" link to
  their targets, with a preview of the target exactly as the document prints it.
- Export an annotated copy of the PDF.

### AI study tools
- **Deep Dive**: select text or a region of a page and get an explanation
  that draws on the surrounding text and related passages elsewhere in the
  document. You can ask follow-ups or dive deeper into a phrase in the answer,
  building a tree of nested dives.
- **Ask** (**⌘J**): ask questions about the whole document, a chapter, or a
  page range ("what does section 3.2 prove?"). Only the relevant passages are
  sent to the model, and you can attach text or page regions to a question.
- **Citations**: each answer cites the passages it relies on. Each citation is
  a chip that jumps to the exact spot in the PDF, and claims from outside the
  document are flagged as such.
- **Glossary**: look up a term and get a definition based on how *this*
  document uses it, along with every place it appears and a matching
  dictionary/Wikipedia entry.
  
## Requirements

- [Node.js](https://nodejs.org) 22.18 or newer (the test suite runs
  TypeScript directly with Node).
- An API key for at least one supported model provider (see
  [Configure API keys](#configure-api-keys)). The reader and annotation features
  work without one, but the AI study tools don't.
- For the desktop app: the [Rust toolchain](https://www.rust-lang.org/tools/install)
  and Tauri's [platform prerequisites](https://tauri.app/start/prerequisites/).

## Getting started

```bash
npm install
cp .env.example .env    # then add your API key (next section)
npm run dev
```

`npm run dev` starts both the Vite frontend and the API server
(`server/`, on port 4300). Open the URL Vite prints, usually
<http://localhost:5173>.

## Configure API keys

All model settings live in `.env` in this directory. The file is git-ignored,
so keys stay local. Start from `.env.example`.

With nothing else set, every feature uses Meta's Muse Spark API
(`muse-spark-1.3-contributor`), so the minimum setup is one line:

```bash
MUSE_SPARK_API_KEY=your-key-here
```

### Providers

| Provider     | Key in `.env`        | Notes                                        |
| ------------ | -------------------- | -------------------------------------------- |
| `muse-spark` | `MUSE_SPARK_API_KEY` | Default. Meta's Muse Spark, via the OpenAI SDK |
| `anthropic`  | `ANTHROPIC_API_KEY`  | Claude API                                   |
| `openai`     | `OPENAI_API_KEY`     | OpenAI API                                   |
| `google`     | `GOOGLE_API_KEY`     | Gemini API                                   |

You only need keys for the providers you actually use.

### Choosing a provider per feature

Each feature runs under a *role*, and each role can use a different provider
and model through `<ROLE>_PROVIDER` and `<ROLE>_MODEL`:

| Role       | Used by                                      | Default                                      |
| ---------- | -------------------------------------------- | -------------------------------------------- |
| `DIVE`     | Deep Dive                                    | `muse-spark` · `muse-spark-1.3-contributor`  |
| `ASK`      | Ask                                          | Whatever `DIVE` uses                         |
| `GLOSSARY` | Glossary definitions and notation lookups    | `muse-spark` · `muse-spark-1.3-contributor`, low reasoning effort |
| `QUICK`    | Short one-shot answers (`/api/dive/quick`) and the grounding eval's `--judge` | `muse-spark` · `muse-spark-1.3-contributor` |

For example, to run Deep Dive and Ask on Claude while keeping the glossary on
Muse Spark:

```bash
DIVE_PROVIDER=anthropic
DIVE_MODEL=claude-sonnet-5
ANTHROPIC_API_KEY=sk-ant-...
MUSE_SPARK_API_KEY=...
```

Restart `npm run dev` after editing `.env`.

### Other settings

| Variable              | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `<ROLE>_MAX_TOKENS`   | Cap on a role's reply length (defaults: DIVE 1024, QUICK 512, GLOSSARY 1024) |
| `REFERENCE_CONTACT`   | Your email or URL, sent to Wikimedia with glossary lookups. Raises their rate limit from 10 to 200 requests a minute |
| `PORT`                | API server port (default 4300)                                |
| `LOG_USAGE=1`         | Log token usage per model call in production (always on in development) |

## Desktop app

```bash
npm run tauri dev     # native window against the Vite dev server
npm run tauri build   # installable bundle in src-tauri/target/release/bundle/
```

How the packaged app differs from the browser version:

- **It needs Node.js at runtime.** The app starts its bundled API server with
  the system's `node`, so Node must be installed on any machine that runs it.
- **It reads `.env` at build time.** `npm run tauri build` copies your `.env`
  into the bundle. Rebuild after changing keys or providers. Because your keys
  ship inside the bundle, don't distribute a build made with your personal
  `.env`.
- **It stores data as plain files.** Your library and notes go in the app data
  folder (on macOS, `~/Library/Application Support/com.knowayreader.app/library/`),
  one folder per document. The browser version uses IndexedDB instead.

## Scripts

| Command                  | What it does                                              |
| ------------------------ | --------------------------------------------------------- |
| `npm run dev`            | Start the frontend and API server for development        |
| `npm run build`          | Type-check and build the frontend into `dist/`            |
| `npm start`              | Serve the built frontend and API from one Node process   |
| `npm test`               | Run the unit tests                                        |
| `npm run lint`           | Lint with oxlint                                          |
| `npm run build:server`   | Bundle the API server for the desktop app (run by `tauri build`) |
| `npm run tauri dev` / `build` | Run or package the desktop app                       |
| `npm run eval:grounding` | Evaluate retrieval and citation quality against a corpus (see `scripts/eval-grounding.mjs`) |

## Project layout

```
src/            React + TypeScript frontend
  epub/         EPUB import: unpacking, layout, and conversion to PDF
  deepdive/     Deep Dive panels, prompts and rendering
  ask/          Ask panel and question threads
  glossary/     Glossary lookups and definitions
  notation/     Symbol lookups
  grounding/    Retrieval, prompt sources and citation checking
  xref/         Cross-reference detection and previews
  library/      Library home, import, backup
  storage/      Per-document storage (files on desktop, IndexedDB on web)
server/         Express API server that calls the model providers
  providers/    One module per provider
src-tauri/      Tauri desktop shell
scripts/        Build and eval scripts
```

## Adding a provider

Each provider in `server/providers/` exposes the same small interface
(`streamReply` and `complete`) and is registered in
`server/providers/index.js`. Any service that speaks the OpenAI Chat
Completions API (Groq, Together, Fireworks, and so on) can be added the way
`museSpark.js` wraps `openAiCompatible.js` with its own base URL.

## Built with

React, TypeScript, Vite, Express, Tauri,
[react-pdf-highlighter-plus](https://www.npmjs.com/package/react-pdf-highlighter-plus)
(patched via `patch-package`), pdf.js, pdf-lib, fflate, KaTeX and Mermaid.
EPUBs are set in [Literata](https://github.com/googlefonts/literata) and
[DejaVu](https://dejavu-fonts.github.io) (both under open font licenses).
