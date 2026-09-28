export interface DiveTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO timestamp
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
  turns: DiveTurn[];
  createdAt: string;
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
