import type { Attachment, RegionRect } from "../grounding/attachments.ts";
import type { SourceRef } from "../grounding/types.ts";
import type { DiveSuggestion } from "./suggestions.ts";

export interface DiveTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO timestamp
  // On a grounded assistant turn: the passages it was given, which its
  // [S1]-style citation markers refer to. Absent on turns from before
  // grounding, and on replies made without the document's text.
  sources?: SourceRef[];
  // On a reader's turn: text they added to the question ("Add to question").
  attachments?: Attachment[];
  // Set only by the Deep Dive experiments (experiments.ts):
  suggestions?: DiveSuggestion[]; // on an answer: where to go next (suggestions)
  diagram?: boolean; // on a reader's turn: it asked for a diagram (diagrams)
}

export interface DiveImage {
  mediaType: string;
  data: string; // base64, no data: URL prefix
}

export interface DivePanel {
  id: string;
  parentId: string | null; // null = anchored directly to the PDF (root)
  anchorHighlightId: string | null; // set iff parentId is null
  selection: string; // exact phrase dived into; empty for an area/image-only highlight
  selectionImage?: DiveImage; // screenshot for an area highlight dive; resent on every turn
  label: string; // selection, truncated to 60 chars
  contextText: string; // page(+prev page) text (root) or parent turn text (nested)
  // Root dives: the page the selection is on (older dives: derived from the
  // anchor highlight instead).
  pageNumber?: number;
  // Nested dives: the passages the parent answer cited where the reader
  // selected from — still the relevant document text one level down.
  inheritedSources?: SourceRef[];
  turns: DiveTurn[];
  createdAt: string;
  // Set only by the Deep Dive experiments (experiments.ts):
  region?: RegionRect; // area dives: the region selected (areaContext)
  baseSources?: SourceRef[]; // the first answer's sources, kept for follow-ups (stableSources)
  summary?: DiveTreeSummary; // root dives: a summary of the whole tree (treeSummary)
}

// A one-page summary of everything explored from one passage.
export interface DiveTreeSummary {
  content: string; // markdown, with [S1]-style citations into `sources`
  sources: SourceRef[];
  at: string; // ISO timestamp
  turnCount: number; // answers in the tree when it was made — more since means it's out of date
}

export interface Pin {
  id: string;
  text: string;
  context: string;
  comment?: string;
  createdAt: string;
}

// A freeform note with no anchor to any page or selection — for jotting
// something down that isn't "about" a specific spot in the document.
export interface GeneralNote {
  id: string;
  text: string;
  createdAt: string;
}

// A highlight placed on AI dialogue text inside a dive panel. Unlike a PDF
// CommentedHighlight (react-pdf-highlighter-plus/Highlight), there is no
// page/boundingRect position to anchor to — the panel's turns are plain
// markdown strings re-rendered on every render, so the highlight is
// re-located by matching `text` against the rendered content instead (see
// DivePanelPane's annotation wrapping).
export interface DiveHighlight {
  id: string;
  panelId: string;
  text: string;
  comment?: string;
  highlightColor?: string;
  highlightStyle?: "highlight" | "underline" | "strikethrough";
  // Set once "Dive deeper" has been used from this highlight, so reopening
  // it (via DiveControl) returns to that same nested dive instead of
  // starting a new one each time — mirrors CommentedHighlight.divePanelId.
  divePanelId?: string;
  // Where in the panel the highlighted text is: the turn, and which copy of
  // `text` within that turn (0 = first). Unset on highlights saved before
  // this was recorded, which fall back to the first match in any turn.
  turnIndex?: number;
  occurrence?: number;
  createdAt: string;
}

export type DiveHighlightPlacement = Pick<DiveHighlight, "turnIndex" | "occurrence">;

export interface ChainEntry {
  id: string | null; // null = the PDF root
  label: string;
}
