# Deep Dive — Design Spec

Date: 2026-08-14
Status: Approved for planning

## 1. Summary

Port the "Deep Dive" feature from `LearningApp` into `PdfHighlighterApp`: select text
anywhere (in the PDF, or inside a Deep Dive reply) and open a scoped AI chat panel about
it, nestable to arbitrary depth. Unlike LearningApp's single-panel "Focus mode," Deep
Dive here opens a dedicated split view with the PDF as one pane and the active dive
chain's most recent panels as the other, connected by a clickable breadcrumb.

This spec assumes familiarity with `PdfHighlighterApp`'s existing structure
(`src/App.tsx`, `src/components/*`, highlight persistence in `localStorage`) and with
LearningApp's Deep Dive architecture (tree-of-panels data model, selection popover,
per-branch system prompts) — see `docs/superpowers/specs/2026-07-17-dive-deeper-panels-design.md`
in the LearningApp repo for the prior art this design adapts.

## 2. Non-goals

- No multi-device sync or server-side persistence of the dive tree (client-only,
  `localStorage`, same pattern as existing highlights).
- No dragging/repositioning of panes; the split view always shows at most 2 panes,
  and the window is derived automatically from the current focus, not manually
  arranged.
- No depth limit on nesting, but no dedicated "map of all dives" graph overview
  (LearningApp's `deepdive.js` pan/zoom view) — out of scope for this iteration.
- No authentication/multi-user concerns; this remains a self-use local app.

## 3. Architecture

Two new pieces are added to the existing Vite + React SPA:

### 3.1 Backend: thin LLM proxy (`server/`)

A small Express server, modeled on LearningApp's `lib/models.js`, spawns the local
`claude` CLI as a child process per request and streams/returns its output. It is
**stateless** — no session store, no file persistence — because the dive tree itself
lives entirely in the browser's `localStorage`, unlike LearningApp where sessions must
survive server restarts and resume across devices.

Two endpoints:

- `POST /api/dive/stream` — body `{ system: string, messages: {role, content}[] }`.
  Spawns `claude -p --system-prompt <system> --model <DIVE_MODEL> --output-format
  stream-json --include-partial-messages --verbose <lastUserMessage>` (mirroring
  LearningApp's invocation), streams `text/event-stream` deltas (`data: {"text":
  "..."}\n\n`) to the client as they arrive, and a final `data: {"done": true}\n\n`.
  Errors surface as `data: {"error": "..."}\n\n`.
- `POST /api/dive/quick` — body `{ system: string, prompt: string }`. Blocking call
  using `QUICK_MODEL`, returns `{ answer: string }` as JSON (mirrors LearningApp's
  `quickAnswer`).

Env vars (`.env`, with `.env.example` committed):

```
# Requires the `claude` CLI installed and logged in (rides your Claude subscription).
# PORT=4300
# DIVE_MODEL=claude-sonnet-5
# QUICK_MODEL=claude-haiku-4-5-20251001
# CLAUDE_BIN=claude
```

`package.json` gains `express` and a dev-only `concurrently` dependency; `npm run dev`
becomes `concurrently "vite" "node server/index.js"`. `vite.config.ts` gets a dev
proxy: `server.proxy["/api"] = "http://localhost:4300"`. For production, `npm run
build` still produces static `dist/`; `server/index.js` additionally serves `dist/`
as static files when `NODE_ENV=production`, so `node server/index.js` alone can run
the whole app in one process (matching `CourseCreationTool`'s `npm start` pattern).

### 3.2 Frontend: `src/deepdive/` module

New files:

- `src/deepdive/types.ts` — `DiveTurn`, `DivePanel`, `Pin` (see §4).
- `src/deepdive/store.ts` — `localStorage` read/write for panels + pins, keyed per
  loaded PDF (same key scheme as highlights), plus pure tree helpers:
  `ancestorChain(panels, focusId)`, `panelById`, `createRootPanel`, `createNestedPanel`,
  `appendTurn`.
- `src/deepdive/api.ts` — thin fetch wrappers: `streamDiveReply({ system, messages,
  onText }): Promise<string>` (reads the SSE body, mirrors App.tsx's existing
  `handleExport`-style async/await usage, not `EventSource` since it's a POST),
  `quickMeaning({ system, prompt }): Promise<string>`.
- `src/deepdive/prompts.ts` — `buildDiveSystem(panel, parentPanel, fileName)`,
  `buildQuickMeaningSystem(fileName)`, `openingMessage(selection)`.
- `src/deepdive/SelectionPopover.tsx` — the 3-action popover (Dive deeper / Quick
  meaning / Pin), reused both from the PDF's `ExpandableTip` and from selections made
  inside a dive panel's chat text.
- `src/deepdive/DeepDiveView.tsx` — breadcrumb + 2-pane row container.
- `src/deepdive/DivePanelPane.tsx` — renders one dive panel: turn history, streaming
  bubble, composer, inline nested-selection markers.
- `src/deepdive/PdfPane.tsx` — the PDF viewer, extracted from `App.tsx`'s current
  `<main className="viewer">…</main>` block so it can be reused both as the normal
  full-width view and as a pane inside `DeepDiveView`.

## 4. Data model

```ts
export interface DiveTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO timestamp
}

export interface DivePanel {
  id: string;
  parentId: string | null;          // null = anchored directly to the PDF (root)
  anchorHighlightId: string | null; // set iff parentId is null — the highlight this
                                      // dive is attached to, for the badge/reopen flow
  selection: string;                 // exact phrase dived into
  label: string;                     // selection, truncated to 60 chars
  contextText: string;                // page+prev-page text (root) or parent's full
                                      // reply text (nested) — see §6
  turns: DiveTurn[];
  createdAt: string;
}

export interface Pin {
  id: string;
  text: string;
  context: string; // enclosing paragraph/page text, for later reference
  createdAt: string;
}
```

The PDF itself is not a `DivePanel` — it's an implicit root, synthesized client-side
as `{ id: null, label: fileName }` wherever the ancestor chain is built, mirroring
LearningApp's treatment of the main thread.

`CommentedHighlight` (`src/types.ts`) gains one optional field:

```ts
export interface CommentedHighlight extends Highlight {
  // ...existing fields...
  divePanelId?: string; // set when "Dive deeper" was used on this highlight
}
```

### 4.1 Persistence keys

Alongside the existing `pdf-highlights:<name>:<size>:<mtime>` key:

```
pdf-dives:<name>:<size>:<mtime>  → DivePanel[]
pdf-pins:<name>:<size>:<mtime>   → Pin[]
```

Both load/save on the same `useEffect` cadence already used for highlights in
`App.tsx`.

## 5. Trigger UX

`ExpandableTip.tsx` currently shows one button ("Add highlight") that expands into a
`CommentForm`. It becomes a 3-action `SelectionPopover`:

- **Add highlight** — unchanged: expands to the existing comment form, saves a
  highlight.
- **Dive deeper** — saves the current selection as a highlight (comment left empty,
  `divePanelId` set to a newly created `DivePanel`), sets `diveFocusId` to that
  panel's id (entering Deep Dive mode), and auto-sends the opening message (see §6)
  to start the first streamed reply.
- **Quick meaning** — no highlight, no panel. Calls `POST /api/dive/quick` and shows
  the answer inline in the popover itself (loading state while pending), exactly like
  LearningApp's popover behavior.
- **Pin** — no highlight, no panel. Appends a `Pin` to the pins store; no LLM call.

The same `SelectionPopover` component is reused for text selections made inside a
`DivePanelPane`'s rendered chat turns (via a `mouseup` listener on the turn list,
analogous to LearningApp's `el.dialogue.addEventListener("mouseup", …)`), where
"Dive deeper" creates a *nested* panel (`parentId` = the panel being read,
`anchorHighlightId` = `null`) instead of a root one.

## 6. Prompts

`buildDiveSystem(panel, parentPanel, fileName)`:

- **Root dive** (`parentPanel` is `null`): context is the selected phrase plus the
  extracted text of the PDF page the selection is on and the page before it (via
  `react-pdf-highlighter-plus`'s text extraction, e.g. `extractPageTextItems`/
  `extractSentences`). If page-text extraction fails for any reason, fall back to the
  selected phrase alone rather than blocking dive creation.
- **Nested dive** (`parentPanel` set): context is the selected phrase plus the full
  text of the specific assistant turn in `parentPanel` that the selection was made
  in.

Both cases produce a system prompt of the shape:

```
You are a knowledgeable guide helping a reader understand a PDF titled "<fileName>".
The reader selected this passage to dive deeper into: "<selection>"
[Nested only: This is a deeper dive within: "<parentPanel.selection>".]

Relevant context:
"""
<contextText>
"""

Explain the selection clearly, scoped to this context. Keep replies focused; the
reader can ask follow-up questions in this same panel.
```

On panel creation, `openingMessage(selection)` = `I'd like to dive deeper into:
"<selection>"` is sent automatically as the first user turn, exactly as in
LearningApp, so the panel opens already streaming an answer rather than sitting empty
waiting for input.

`buildQuickMeaningSystem(fileName)` mirrors LearningApp's `quickMeaningRequest`:
one-shot, "at most two plain-language sentences," given the selection and up to
1000 chars of the current page's text as context.

## 7. Deep Dive split view

### 7.1 Mode toggle

`App.tsx` gains `diveFocusId: string | null` state.

- `null` → today's layout, unchanged: toolbar, `Sidebar`, full-width `PdfPane`.
- non-`null` → render `DeepDiveView` in place of the `.workspace` div. The toolbar
  stays; the sidebar does not (dive mode is a distinct screen, matching the earlier
  agreed "clicking the root breadcrumb exits entirely" behavior — there is no
  separate "single-pane dive mode" state, since a chain of length 1 *is* `diveFocusId
  === null`).

### 7.2 Breadcrumb

`DeepDiveView` computes `chain = ancestorChain(panels, diveFocusId)` → ordered
`{ id: string | null, label: string }[]` from the root (PDF) to the focused panel.
Rendered as `Book Title › Bit vs Qubit › Superposition › …`, each crumb clickable:

- Clicking the root crumb sets `diveFocusId = null` (exits Deep Dive mode entirely).
- Clicking any other crumb sets `diveFocusId` to that crumb's panel id (the window
  recomputes from the new, shorter chain).

### 7.3 Pane window

Given `chain` (always length ≥ 2 while `DeepDiveView` is mounted, since `diveFocusId
!== null`), the visible window is `chain.slice(-2)`: the focused panel and its
immediate predecessor in the chain. Left pane renders `PdfPane` if that predecessor's
id is `null` (root), otherwise `DivePanelPane`. Right pane always renders
`DivePanelPane` for the focused id.

Diving deeper from **either visible pane** creates a new `DivePanel` whose `parentId`
is that pane's panel id (or `null`/root if diving from the PDF pane), sets
`diveFocusId` to the new panel's id, and the window slides to
`[that pane's panel, new panel]` — matching "always 2 panes, sliding right as you go
deeper." Diving from the PDF pane while already in Deep Dive mode starts a fresh
lineage (`[root, newPanel]`), abandoning whatever was previously in the right pane
(still reachable via its own highlight badge, if any, or its own nested-selection
marker chain).

The `PdfPane` is always fully interactive in both layouts — the same highlight/
comment/area-highlight/sticky-note/dive-trigger flows work whether or not it's
currently a Deep Dive pane.

### 7.4 Reopening a branch

- **Root-level dives**: the source highlight (in `PdfPane` and in `Sidebar`'s
  annotation list) shows a small "Dive ↗" badge when `highlight.divePanelId` is set.
  Clicking it sets `diveFocusId = highlight.divePanelId`.
- **Nested dives**: `DivePanelPane` renders each assistant turn's text with any
  previously-dived substrings wrapped in a clickable marker (matched by
  `DivePanel.selection` against turn content), which sets `diveFocusId` to that
  child panel's id — so a branch is reachable by scrolling back to where it was
  created, without needing the breadcrumb.

## 8. Sidebar changes

`Sidebar.tsx` gains a **Pins** section (new, below the existing Annotations list):
lists `Pin.text` with a delete button; clicking a pin does nothing special for v1
(no "resolve" concept, no jump target — pins aren't tied to a PDF location the way
highlights are). Annotation list items with `divePanelId` set show the "Dive ↗"
badge described in §7.4.

## 9. Error handling

- `claude` CLI missing / not logged in / process spawn failure → the stream endpoint
  emits a `data: {"error": "..."}\n\n` frame; `DivePanelPane` renders it as an error
  bubble in place of the streaming reply (same visual treatment as a normal failed
  turn), and the composer re-enables so the user can retry.
- Page-text extraction failure when building root-dive context → fall back to
  selection-only context (§6), never blocks panel creation.
- Quick meaning failures → shown inline in the popover in place of the answer text.
- Network failure reaching `/api/dive/*` in dev (backend not running) → same error
  bubble path; the popover/composer never throws unhandled.

## 10. Testing / verification plan

No test framework exists in this project today (`tsc -b`, `vite build`, and `oxlint`
are the only checks). This feature adds no new framework; verification is:

1. `tsc -b` and `vite build` stay clean.
2. `oxlint` stays clean.
3. Manual Playwright-driven walkthrough (same approach used for the earlier text-
   layer CSS fix) against a real PDF, with the local `claude` CLI available and
   logged in:
   - Select text → **Dive deeper** → highlight appears with a badge, split view
     opens with `[PDF, new panel]`, opening message streams a reply.
   - Select text inside that reply → **Dive deeper** again → window slides to
     `[panel 1, panel 2]`, breadcrumb now shows 3 crumbs.
   - Click the panel-1 crumb → window becomes `[PDF, panel 1]`.
   - Click the root crumb → exits to the normal single-pane view.
   - Click the dive badge on the original highlight → re-enters at `[PDF, panel 1]`.
   - **Quick meaning** on a selection → inline answer, no highlight/panel created.
   - **Pin** on a selection → appears in the new Sidebar Pins section.
4. Note in the report to the user that steps requiring the `claude` CLI depend on
   local login state outside this session's control, same caveat LearningApp's own
   README carries.

## 11. Open items deferred (explicitly out of scope, revisit later if needed)

- LearningApp's separate full-tree graph overview (`deepdive.js` pan/zoom) — not
  ported; the breadcrumb + badges/markers are the only navigation aids for now.
- Deleting a dive panel/subtree — LearningApp explicitly removed this from its UI
  ("dives are never deleted"); same choice made here by omission (no delete action
  designed for panels, only for pins and highlights as today).
