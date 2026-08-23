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
  createdAt: string;
}

export interface ChainEntry {
  id: string | null; // null = the PDF root
  label: string;
}
