import type { DocumentTextIndex, IndexedPage, TermMatch } from "../glossary/textIndex.ts";
import type { Section } from "../text/sections.ts";

// Notation: what a symbol (ψ, H, x_i, ρ_A) means in this document — at the
// point the reader is reading, since books reuse symbols from chapter to
// chapter. Pure: symbols are found in the text index, and a symbol's
// candidate definitions scored by the phrasing around them, so the model
// only ever sees a handful of likely defining passages.

// ---- What counts as a symbol ---------------------------------------------------

const MATH_CHAR =
  /[Ͱ-Ͽᴀ-ᶿ⁰-₟℀-⅏←-⋿⨀-⫿⟨⟩‖∞√∑∏∫∂∇±×÷≤≥≠≈≡′″ˆ˜¯]/u;
const COMMON_SHORT_WORDS = new Set(
  "a an as at be by do go he if in is it me my no of on or so to up us we am ok vs id".split(" "),
);

// A selection that names notation rather than a term: a Greek letter or
// math sign, a lone letter, or a letter with a subscript/prime/number
// (x1, x', a_n, ρA). Words — even short ones — stay terms.
export function isSymbolCandidate(selection: string): boolean {
  const text = selection.normalize("NFKC").replace(/\s+/g, "");
  if (!text || text.length > 8) return false;
  if (MATH_CHAR.test(text)) return true;
  if (/^[A-Za-z]$/.test(text)) return true;
  if (/^[A-Za-z][_^'′]?[0-9A-Za-z]{0,2}['′]?$/.test(text) && /[0-9_^'′]/.test(text)) return true;
  if (/^[A-Za-z]{2}$/.test(text) && !COMMON_SHORT_WORDS.has(text.toLowerCase()) && /[A-Z]/.test(text)) return true;
  return false;
}

// A symbol as a lookup key and search needle: compatibility forms folded
// (NFKC turns 𝜓 into ψ and ₁ into 1), spaces and "_"/"^" markup dropped.
export function normalizeSymbol(symbol: string): string {
  return symbol.normalize("NFKC").replace(/[\s_^{}​-‍]/g, "");
}

export function symbolKey(symbol: string): string {
  return `sym:${normalizeSymbol(symbol)}`;
}

// ---- Where a symbol appears, and where it's defined -------------------------------

export interface SymbolSite extends TermMatch {
  score: number; // how strongly the wording around it reads as a definition
}

const DEFINES_AFTER =
  /^\s*(?:\([^)]{0,20}\)\s*)?(?::=|≡|≜|denotes?\b|stands? for\b|represents?\b|will (?:denote|be)\b|refers? to\b|is (?:called|defined|the|a|an|given by|our)\b|are (?:the|called)\b)/i;
const EQUALS_AFTER = /^\s*=/;
const DEFINES_BEFORE =
  /(?:\blet|\bwhere|\bwith|\bdenoted? by|\bwe (?:write|use|denote)|\bdefine|\bdefined as|\bthe symbol|\bwritten|\bcalled|\bsymbol)\s*$/i;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolPattern(symbol: string): RegExp {
  const needle = normalizeSymbol(symbol);
  const body = [...needle].map(escapeRegExp).join("\\s?");
  // A symbol that starts or ends with a letter/digit must stand alone there
  // ("n" in "n + 1", not in "and").
  const start = /^[\p{L}\p{N}]/u.test(needle) ? "(?<![\\p{L}\\p{N}])" : "";
  const end = /[\p{L}\p{N}]$/u.test(needle) ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`${start}${body}${end}`, "gu");
}

export function scoreSite(page: IndexedPage, start: number, end: number): number {
  const before = page.text.slice(Math.max(0, start - 40), start);
  const after = page.text.slice(end, end + 40);
  let score = 0;
  if (DEFINES_AFTER.test(after)) score += 3;
  else if (EQUALS_AFTER.test(after)) score += 1;
  if (DEFINES_BEFORE.test(before)) score += 3;
  if (/\bwhere\b[^.]{0,40}$/i.test(before) && /^\s*(?:is|are)\b/i.test(after)) score += 2;
  return score;
}

export const DEFINING_SCORE = 3;

// Every occurrence of the symbol, scored. A lone letter occurs everywhere
// as ordinary text ("a", "I"), so only its defining-looking occurrences are
// kept.
export function findSymbolSites(index: DocumentTextIndex, symbol: string): SymbolSite[] {
  const pattern = symbolPattern(symbol);
  const loneLetter = /^[A-Za-z]$/.test(normalizeSymbol(symbol));
  const sites: SymbolSite[] = [];
  for (const page of index.pages) {
    for (const match of page.text.matchAll(pattern)) {
      const site = { page, start: match.index, end: match.index + match[0].length };
      const score = scoreSite(page, site.start, site.end);
      if (loneLetter && score < DEFINING_SCORE) continue;
      sites.push({ ...site, score });
    }
  }
  if (sites.length) sites[0] = { ...sites[0], score: sites[0].score + 1 }; // its first use
  return sites;
}

// The passages to show the model for a lookup on `page`: the likeliest
// definitions at or before it (strongest first, nearer ones breaking ties),
// then a couple after it (in case it's only defined later).
export function pickSites(sites: SymbolSite[], page: number, before = 4, after = 2): SymbolSite[] {
  const defining = sites.filter((site) => site.score >= DEFINING_SCORE);
  const earlier = defining
    .filter((site) => site.page.pageNumber <= page)
    .sort((a, b) => b.score - a.score || b.page.pageNumber - a.page.pageNumber || b.start - a.start)
    .slice(0, before);
  const later = defining.filter((site) => site.page.pageNumber > page).slice(0, after);
  const chosen = [...earlier, ...later];
  // Nothing reads as a definition: the first few uses, which usually explain it.
  if (chosen.length === 0) return sites.slice(0, before);
  return chosen.sort((a, b) => a.page.pageNumber - b.page.pageNumber || a.start - b.start);
}

// Pages after `page` where the symbol looks defined again — shown as "also
// defined on p. 88", so the reader knows the meaning may change there.
export function laterDefinitionPages(sites: SymbolSite[], page: number, max = 3): number[] {
  return [
    ...new Set(sites.filter((s) => s.score >= DEFINING_SCORE && s.page.pageNumber > page).map((s) => s.page.pageNumber)),
  ].slice(0, max);
}

// ---- The document's own list of symbols -------------------------------------------

export interface SymbolListEntry {
  symbol: string;
  key: string;
  meaning: string;
  pageNumber: number; // where the list shows it
  start: number; // its offset in that page's text
}

const LIST_HEADING =
  /^(?:list of (?:symbols|notations?|abbreviations and symbols)|notations?|nomenclature|symbols|glossary of (?:symbols|notation)|table of notation|symbols and notation)$/i;

// A "List of Symbols" / "Notation" section: each line is a symbol, a gap,
// then its meaning (and often a page number, dropped).
export function parseSymbolList(index: DocumentTextIndex, sections: Section[], maxPages = 4): SymbolListEntry[] {
  let startPage = -1;
  const section = sections.find((s) => LIST_HEADING.test(s.title.replace(/^[\d.]+\s*/, "").trim()));
  if (section) startPage = section.pageNumber - 1;
  else {
    startPage = index.pages.findIndex((page) =>
      page.items.some((item) => LIST_HEADING.test(item.text.trim())),
    );
  }
  if (startPage < 0) return [];

  const entries: SymbolListEntry[] = [];
  for (let p = startPage; p < Math.min(index.pages.length, startPage + maxPages); p += 1) {
    const page = index.pages[p];
    // Items grouped into lines, in order. pdf.js adds whitespace-only runs
    // spanning the gaps between words and columns; they'd hide the very gap
    // between a symbol and its meaning, so they're left out.
    const lines: number[][] = [];
    page.items.forEach((item, i) => {
      if (!item.text.trim()) return;
      const line = lines[lines.length - 1];
      const previous = line ? page.items[line[line.length - 1]] : undefined;
      if (previous && Math.abs(previous.rect.top - item.rect.top) < Math.min(previous.rect.height, item.rect.height) * 0.5) {
        line.push(i);
      } else {
        lines.push([i]);
      }
    });
    for (const line of lines) {
      if (line.length < 2) continue;
      const [first, second] = [page.items[line[0]], page.items[line[1]]];
      const symbol = first.text.trim();
      const gap = second.rect.left - (first.rect.left + first.rect.width);
      if (!symbol || symbol.length > 12 || LIST_HEADING.test(symbol) || gap < first.rect.height * 0.8) continue;
      const meaning = line
        .slice(1)
        .map((i) => page.items[i].text)
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/[\s.·…]+\d{1,4}$/, "")
        .trim();
      if (!meaning || !/\p{L}/u.test(meaning)) continue;
      const start = page.charItem.indexOf(line[0]);
      entries.push({ symbol, key: symbolKey(symbol), meaning, pageNumber: page.pageNumber, start: Math.max(0, start) });
    }
  }
  return entries;
}

// ---- Meanings by where they start ---------------------------------------------------

export interface NotationMeaning {
  fromPage: number; // where this meaning starts (its definition, or where it was looked up)
  definition: string;
  source: "defined" | "inferred" | "general";
  refId?: string; // the entry's reference where it's defined
}

// The meaning in effect on `page`: the latest one starting at or before it;
// failing that, the earliest (a symbol only defined later), flagged.
export function meaningAt(
  meanings: NotationMeaning[] | undefined,
  page: number,
): { meaning: NotationMeaning; definedLater: boolean } | null {
  if (!meanings?.length) return null;
  const sorted = [...meanings].sort((a, b) => a.fromPage - b.fromPage);
  const inEffect = sorted.filter((m) => m.fromPage <= page).pop();
  return inEffect ? { meaning: inEffect, definedLater: false } : { meaning: sorted[0], definedLater: true };
}

// Adds a looked-up meaning, replacing one that starts on the same page.
export function mergeMeaning(meanings: NotationMeaning[] | undefined, next: NotationMeaning): NotationMeaning[] {
  return [...(meanings ?? []).filter((m) => m.fromPage !== next.fromPage), next].sort((a, b) => a.fromPage - b.fromPage);
}

// Whether a lookup on `page` can reuse the meaning already known there: no
// new definition of the symbol appears between that meaning's start and
// the page.
export function needsLookup(meanings: NotationMeaning[] | undefined, sites: SymbolSite[], page: number): boolean {
  const known = meaningAt(meanings, page);
  if (!known || known.definedLater) return true;
  return sites.some(
    (s) => s.score >= DEFINING_SCORE && s.page.pageNumber > known.meaning.fromPage && s.page.pageNumber <= page,
  );
}
