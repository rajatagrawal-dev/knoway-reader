import type { SourceRef } from "../grounding/types.ts";

// What the reader has already noted near a dive's selection (the
// readerNotes experiment): glossary definitions for terms in play, their
// own highlight comments on nearby pages, and other passages they dove into
// close by. Sent as hints about what they know and have looked at — never
// as sources, since none of it is the document's own text.

export interface NoteGlossaryEntry {
  term: string;
  aliases: string[];
  definition: string;
  source?: "defined" | "inferred" | "general";
}

export interface NoteHighlight {
  pageNumber: number;
  text: string;
  comment: string;
}

export interface NoteDive {
  label: string;
  pageNumber: number;
  summary?: string; // its tree summary's opening line, if there is one
}

const MAX_TERMS = 6;
const MAX_HIGHLIGHTS = 4;
const MAX_DIVES = 4;
const DEFINITION_CHARS = 200;
const COMMENT_CHARS = 200;
const QUOTE_CHARS = 80;
const HIGHLIGHT_PAGES = 1; // the selection's page, and this many either side
const DIVE_PAGES = 3;

const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return escaped ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text) : false;
}

const ORIGIN: Record<NonNullable<NoteGlossaryEntry["source"]>, string> = {
  defined: "as the document defines it",
  inferred: "inferred from the document",
  general: "general meaning",
};

export function readerNotesBlock(params: {
  selection: string;
  sources: SourceRef[];
  pageNumber: number | null; // the page being read (a nested dive: its tree's)
  glossary: NoteGlossaryEntry[];
  highlights: NoteHighlight[];
  dives: NoteDive[]; // other root dives in this document, this one excluded
  pageLabel: (pageNumber: number) => string;
}): string {
  const haystack = [params.selection, ...params.sources.map((source) => source.text)].join("\n");
  const terms = params.glossary
    .filter((entry) => entry.definition.trim() && [entry.term, ...entry.aliases].some((name) => mentions(haystack, name)))
    .slice(0, MAX_TERMS)
    .map((entry) => `- ${entry.term}: ${clip(entry.definition, DEFINITION_CHARS)}${entry.source ? ` (${ORIGIN[entry.source]})` : ""}`);

  const page = params.pageNumber;
  const near = (pageNumber: number, span: number) => page !== null && Math.abs(pageNumber - page) <= span;
  const highlights = params.highlights
    .filter((highlight) => highlight.comment.trim() && near(highlight.pageNumber, HIGHLIGHT_PAGES))
    .slice(0, MAX_HIGHLIGHTS)
    .map(
      (highlight) =>
        `- Their note on p. ${params.pageLabel(highlight.pageNumber)}${highlight.text ? ` ("${clip(highlight.text, QUOTE_CHARS)}")` : ""}: ${clip(highlight.comment, COMMENT_CHARS)}`,
    );
  const dives = params.dives
    .filter((dive) => near(dive.pageNumber, DIVE_PAGES))
    .slice(0, MAX_DIVES)
    .map(
      (dive) =>
        `- They explored "${clip(dive.label, QUOTE_CHARS)}" (p. ${params.pageLabel(dive.pageNumber)})${dive.summary ? `: ${clip(dive.summary, COMMENT_CHARS)}` : ""}`,
    );

  const parts = [
    terms.length ? `Glossary:\n${terms.join("\n")}` : "",
    highlights.length ? `Their notes nearby:\n${highlights.join("\n")}` : "",
    dives.length ? `Passages nearby they already dove into:\n${dives.join("\n")}` : "",
  ].filter(Boolean);
  if (parts.length === 0) return "";
  return `What the reader has noted (hints about what they know and have looked at — not sources, never cite them; build on them rather than repeat them):\n${parts.join("\n")}`;
}
