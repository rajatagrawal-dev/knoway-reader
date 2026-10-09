import type { ScaledPosition } from "react-pdf-highlighter-plus";
import type { NotationMeaning } from "../notation/symbols";

// How the definition was arrived at, shown as a badge so the reader knows
// how much to trust it: the document itself defines/introduces the term,
// the meaning was worked out from how the document uses it, or the
// document doesn't say and this is the field's standard meaning.
export type GlossarySource = "defined" | "inferred" | "general";

export type GlossaryStatus = "pending" | "streaming" | "done" | "error";

// Where the term comes from, shown as a chip beside it: an everyday word
// ("Common English word"), a field's term of art ("Quantum computing
// term"), a word or phrase from another language ("Latin phrase"), a name,
// or an abbreviation. `detail` is the language, field or kind of name.
export type OriginKind = "common" | "technical" | "foreign" | "name" | "abbreviation";

export interface GlossaryOrigin {
  kind: OriginKind;
  detail?: string;
}

// The dictionary or encyclopedia entry the model matched to the document's
// sense of the term, shown verbatim beside its own definition.
export interface GlossaryReference {
  site: "Wiktionary" | "Wikipedia";
  label: string; // "Latin phrase", or the Wikipedia article's title
  text: string;
  url: string;
}

// What /api/reference returns: the candidates for GlossaryReference.
export interface ReferenceLookup {
  dictionary: {
    url: string;
    entries: { language: string; partOfSpeech: string; senses: string[] }[];
  } | null;
  encyclopedia: { title: string; extract: string; url: string }[];
}

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
  origin?: GlossaryOrigin;
  literal?: string; // word-for-word meaning, for a foreign word or an idiom
  reference?: GlossaryReference;
  definedRefId?: string; // the reference where the document defines it
  aliases: string[]; // other names the document uses, searched for refs too
  refs: GlossaryRef[]; // capped at MAX_STORED_REFS, in document order
  refCount: number; // total occurrences found, which may exceed refs.length
  createdAt: string;

  // ---- Notation (kind "symbol"; see src/notation) ----
  // Absent on terms. For a symbol, `definition`/`source`/`definedRefId` hold
  // the meaning in effect where it was last looked up (`pageNumber`), and
  // `meanings` every meaning found so far, each from the page it starts.
  kind?: "term" | "symbol";
  symbolLatex?: string; // "$\\rho_A$" — the symbol as the model wrote it
  meanings?: NotationMeaning[];
  laterDefinitionPages?: number[]; // pages after the lookup that seem to define it again
  image?: { mediaType: string; data: string }; // an area-selected symbol, as printed
}
