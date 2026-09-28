import type { ScaledPosition } from "react-pdf-highlighter-plus";

// How the definition was arrived at, shown as a badge so the reader knows
// how much to trust it: the document itself defines/introduces the term,
// the meaning was worked out from how the document uses it, or the
// document doesn't say and this is the field's standard meaning.
export type GlossarySource = "defined" | "inferred" | "general";

export type GlossaryStatus = "pending" | "streaming" | "done" | "error";

// One occurrence of the term in the document — a jump target from the
// glossary panel. `before`/`match`/`after` is a keyword-in-context snippet.
export interface GlossaryRef {
  id: string;
  pageNumber: number;
  before: string;
  match: string;
  after: string;
  position: ScaledPosition;
}

export interface GlossaryEntry {
  id: string;
  term: string; // as selected, trimmed of surrounding punctuation
  key: string; // termKey(term) — dedupes "Qubits" against "qubit"
  pageNumber: number; // page the term was added from
  status: GlossaryStatus;
  error?: string;
  source?: GlossarySource;
  definition: string; // markdown (with $...$ math)
  definedRefId?: string; // the reference where the document defines it
  aliases: string[]; // other names the document uses, searched for refs too
  refs: GlossaryRef[]; // capped at MAX_STORED_REFS, in document order
  refCount: number; // total occurrences found, which may exceed refs.length
  createdAt: string;
}
