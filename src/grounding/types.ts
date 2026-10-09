// A passage of the document given to the model as a numbered source ("S3"),
// and kept with the answer so its citations still resolve — to a page, and
// to exact characters on it — after a reload, without the model or the
// text index.
export interface SourceRef {
  label: string; // "S3" — unique within one request
  pageNumber: number;
  start: number; // [start, end) into the page's normalized text (IndexedPage.text)
  end: number;
  text: string;
  chunkId?: string; // the TextChunk it came from, when it came from one
  // Set only by the Deep Dive context experiments (grounding/context.ts):
  // how the passage was found — for debugging and the eval, never shown —
  // what the selection calls it ("Eq. (3.2)", "Theorem 4.1", "definition of
  // ρ"), and the section it's in. `is` and `section` are shown to the model.
  via?: SourceVia;
  is?: string;
  section?: string;
}

export type SourceVia = "local" | "xref" | "symbol" | "term" | "retrieval" | "attached" | "inherited" | "anchor";

// How a claim relates to the document: stated in a source, reasoned from
// one, or from outside knowledge.
export type CitationKind = "stated" | "inferred" | "general";

// One badge per answer, computed from its citations (never self-reported).
export type AnswerGrounding = "document" | "inferred" | "mixed" | "general" | "not-covered";
