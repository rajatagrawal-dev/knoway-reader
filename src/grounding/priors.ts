import type { DocumentTextIndex } from "../glossary/textIndex.ts";
import type { TextChunk } from "../text/chunks.ts";
import { sectionPageRange, sectionPathAt, type Section } from "../text/sections.ts";
import { isStopword, tokenize, type Bm25Index } from "./retrieval.ts";

// Where a dive's retrieval should look, beyond plain word overlap: the
// selection's own section and what came before it, not back matter (an
// index or bibliography page matches nearly every term). Pure; used only
// by the rankingPriors dive experiment (context.ts). The values are
// guesses, kept in one object so retuning them against the eval is a
// one-line change.

export const PRIORS = {
  sameSection: 1.3, // chunks in the selection's (deepest) section
  earlier: 1.1, // pages before the selection
  far: 0.85, // pages more than farPages away
  farPages: 50,
  numericShare: 0.3, // a page this full of numbers and page lists reads as an index
  minQueryTokens: 3, // shorter selections borrow their sentence's words
  maxQueryTokens: 25, // longer ones keep only their rarest words...
  keptQueryTokens: 12, // ...this many
};

const BACK_MATTER_TITLE =
  /^(?:\d+(?:\.\d+)*\.?\s+)?(?:index|subject index|author index|contents|table of contents|bibliography|references|works cited|list of (?:symbols|figures|tables|notation)|notation|nomenclature)$/i;

// Pages retrieval never takes from (unless the selection is on one): the
// outline's index, contents, bibliography and lists, and — for documents
// without an outline — pages that are mostly numbers.
export function backMatterPages(sections: Section[], index: DocumentTextIndex): Set<number> {
  const pages = new Set<number>();
  const numPages = index.pages.length;
  sections.forEach((section, i) => {
    if (!BACK_MATTER_TITLE.test(section.title.trim())) return;
    const [first, last] = sectionPageRange(sections, i, numPages);
    for (let p = first; p <= last; p += 1) pages.add(p);
  });
  for (const page of index.pages) {
    const tokens = page.text.split(/\s+/).filter(Boolean);
    if (tokens.length < 40) continue;
    const numeric = tokens.filter((token) => /^[\d,;.–—-]+$/.test(token)).length;
    if (numeric / tokens.length > PRIORS.numericShare) pages.add(page.pageNumber);
  }
  return pages;
}

// The pages [first, last] of the deepest section holding `pageNumber`.
export function sectionRangeAt(sections: Section[], pageNumber: number, numPages: number): [number, number] | null {
  const path = sectionPathAt(sections, pageNumber);
  const deepest = path[path.length - 1];
  if (!deepest) return null;
  return sectionPageRange(sections, sections.indexOf(deepest), numPages);
}

// One multiplier per chunk, parallel to `chunks`.
export function diveWeights(chunks: TextChunk[], at: { pageNumber: number; sectionRange: [number, number] | null }): number[] {
  return chunks.map((chunk) => {
    let weight = 1;
    const range = at.sectionRange;
    if (range && chunk.pageNumber >= range[0] && chunk.pageNumber <= range[1]) weight *= PRIORS.sameSection;
    if (chunk.pageNumber < at.pageNumber) weight *= PRIORS.earlier;
    if (Math.abs(chunk.pageNumber - at.pageNumber) > PRIORS.farPages) weight *= PRIORS.far;
    return weight;
  });
}

function idf(bm25: Bm25Index, term: string): number {
  const df = bm25.documentFrequency.get(term) ?? 0;
  return Math.log(1 + (bm25.chunks.length - df + 0.5) / (df + 0.5));
}

// What a dive searches with: a short selection borrows its sentence's
// words, a long one keeps its rarest; plus two-word phrases from the
// selection, for the phrase bonus (retrieval.ts).
export function diveQuery(selection: string, sentence: string, bm25: Bm25Index): { query: string; phrases: string[] } {
  // Whole words (the query is tokenized again when scored), one per folded
  // form.
  const contentWords = (text: string) => {
    const byFold = new Map<string, string>();
    for (const word of text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
      const folded = tokenize(word)[0];
      if (folded && !byFold.has(folded)) byFold.set(folded, word);
    }
    return byFold;
  };
  let tokens = contentWords(selection);
  if (tokens.size < PRIORS.minQueryTokens && sentence) tokens = new Map([...contentWords(sentence), ...tokens]);
  let kept = [...tokens.entries()];
  if (kept.length > PRIORS.maxQueryTokens) {
    kept = kept.sort(([a], [b]) => idf(bm25, b) - idf(bm25, a)).slice(0, PRIORS.keptQueryTokens);
  }
  const query = kept.map(([, word]) => word).join(" ");
  const words = selection.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const phrases: string[] = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const [a, b] = [words[i], words[i + 1]];
    if (a.length > 1 && b.length > 1 && !isStopword(a) && !isStopword(b)) phrases.push(`${a} ${b}`);
  }
  return { query, phrases: [...new Set(phrases)].slice(0, 8) };
}
