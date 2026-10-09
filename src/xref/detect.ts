import type { IndexedPage } from "../glossary/textIndex.ts";
import type { Section } from "../text/sections.ts";

// Cross-references found in the document's own text: what a phrase like
// "Eq. (3.2)", "Theorem 4.1", "Fig. 7", "§3.4" or "[12]" refers to, and
// where that is. Pure — geometry comes from the text index (IndexedPage),
// section titles from the PDF outline. PDFs made with hyperref also carry
// link annotations with exact destinations; those are read separately
// (links.ts) and take priority. Only references whose target is actually
// found get marked, so the reader never hits a dead end.

export type XrefKind = "equation" | "theorem" | "figure" | "table" | "section" | "citation" | "link";

export interface XrefTarget {
  kind: XrefKind;
  key: string; // how references find it: "equation:3.2", "theorem:4.1", "citation:12"
  name: string; // how it's shown: "Eq. (3.2)", "Theorem 4.1", "[12]"
  pageNumber: number;
  // The part of the page the preview shows, as fractions of the page height.
  top: number;
  bottom: number;
  range?: [number, number]; // its anchor in the page text (a label, a caption start)
  entryText?: string; // citations: the bibliography entry
}

export interface XrefRef {
  id: string; // "p12-340"
  pageNumber: number;
  start: number; // [start, end) of the reference in the page text
  end: number;
  text: string;
  targets: XrefTarget[]; // usually one; "[3, 5]" can cite several
  annotationId?: string; // set when it came from a PDF link annotation
}

// ---- Words for numbered things ------------------------------------------------

// Theorem-like environments keep their own name as the key (a "Lemma 4.2"
// reference finds "Lemma 4.2", not "Theorem 4.2").
const ENVIRONMENTS: [RegExp, string, string][] = [
  [/^eq(?:uation)?s?\.?$/i, "equation", "Eq."],
  [/^(?:theorems?|thms?\.?)$/i, "theorem", "Theorem"],
  [/^lemmas?$/i, "lemma", "Lemma"],
  [/^(?:propositions?|props?\.?)$/i, "proposition", "Proposition"],
  [/^(?:corollar(?:y|ies)|cors?\.?)$/i, "corollary", "Corollary"],
  [/^(?:definitions?|defs?\.?)$/i, "definition", "Definition"],
  [/^examples?$/i, "example", "Example"],
  [/^exercises?$/i, "exercise", "Exercise"],
  [/^remarks?$/i, "remark", "Remark"],
  [/^claims?$/i, "claim", "Claim"],
  [/^conjectures?$/i, "conjecture", "Conjecture"],
  [/^problems?$/i, "problem", "Problem"],
  [/^algorithms?$/i, "algorithm", "Algorithm"],
  [/^(?:figures?|figs?\.?)$/i, "figure", "Figure"],
  [/^(?:tables?|tabs?\.?)$/i, "table", "Table"],
  [/^(?:sections?|secs?\.?|§§?|chapters?|chs?\.?|appendi(?:x|ces)|app\.?)$/i, "section", "Section"],
];

function environment(word: string): { env: string; display: string } | null {
  for (const [pattern, env, display] of ENVIRONMENTS) if (pattern.test(word.trim())) return { env, display };
  return null;
}

function kindOf(env: string): XrefKind {
  if (env === "equation" || env === "figure" || env === "table" || env === "section") return env;
  return "theorem";
}

const WORDS =
  "Eqs?\\.|Equations?|Theorems?|Thms?\\.|Lemmas?|Propositions?|Props?\\.|Corollar(?:y|ies)|Cors?\\.|Definitions?|Defs?\\.|Examples?|Exercises?|Remarks?|Claims?|Conjectures?|Problems?|Algorithms?|Figures?|Figs?\\.|Tables?|Tabs?\\.|Sections?|Secs?\\.|Chapters?|Chs?\\.|Appendi(?:x|ces)|§§?";
const NUMBER = "[A-Z]?\\d+(?:\\.\\d+)*[a-z]?";

// ---- Page geometry --------------------------------------------------------------

function sameLine(a: IndexedPage["items"][number], b: IndexedPage["items"][number]): boolean {
  const height = Math.min(a.rect.height, b.rect.height) || a.rect.height || 1;
  return Math.abs(a.rect.top - b.rect.top) < height * 0.5;
}

// Whether the character at `index` begins its line — the first character of
// the first text run on that line (ignoring leading spaces).
function startsLine(page: IndexedPage, index: number): boolean {
  const itemIndex = page.charItem[index];
  if (itemIndex === undefined || itemIndex < 0) return false;
  const item = page.items[itemIndex];
  if (item.text.slice(0, page.charOffset[index]).trim()) return false;
  const previous = page.items[itemIndex - 1];
  return !previous || !sameLine(previous, item);
}

function lineHeight(page: IndexedPage, itemIndex: number): number {
  return page.items[itemIndex]?.rect.height || 10;
}

// The vertical extent (page units) of the text block starting at item
// `from`: following lines until a paragraph-sized gap, up to `maxLines`.
function blockBelow(page: IndexedPage, from: number, maxLines: number): number {
  const first = page.items[from];
  let bottom = first.rect.top + first.rect.height;
  let lines = 1;
  let previousTop = first.rect.top;
  for (let i = from + 1; i < page.items.length && lines < maxLines; i += 1) {
    const item = page.items[i];
    if (item.rect.top <= previousTop + item.rect.height * 0.5) {
      bottom = Math.max(bottom, item.rect.top + item.rect.height);
      continue; // same line
    }
    const gap = item.rect.top - bottom;
    if (gap > lineHeight(page, i) * 1.2) break;
    bottom = item.rect.top + item.rect.height;
    previousTop = item.rect.top;
    lines += 1;
  }
  return bottom;
}

// The bottom (page units) of the nearest text above `top` that's separated
// from it by more than a line — where a figure above its caption begins.
function textAbove(page: IndexedPage, top: number, minGap: number): number {
  let best = 0;
  for (const item of page.items) {
    const bottom = item.rect.top + item.rect.height;
    if (bottom <= top - minGap && bottom > best) best = bottom;
  }
  return best;
}

const fraction = (page: IndexedPage, y: number) => Math.min(1, Math.max(0, y / page.height));

// ---- Targets ------------------------------------------------------------------------

const TARGET_LABEL = new RegExp(`(?<![A-Za-z])(${WORDS})\\s+(${NUMBER})(?=\\s*[.:(—–-]|\\s*$)`, "g");
const EQUATION_LABEL = new RegExp(`^\\(\\s*(${NUMBER})\\s*\\)$`);

function isTheoremOrCaption(env: string) {
  return env !== "equation" && env !== "section";
}

export function findPageTargets(page: IndexedPage): XrefTarget[] {
  const targets: XrefTarget[] = [];

  // "Theorem 4.1.", "Figure 3:", "Table 2." — starting a line, followed by
  // punctuation (a mention mid-paragraph, even one wrapped onto a new line,
  // is followed by more words instead).
  for (const match of page.text.matchAll(TARGET_LABEL)) {
    const found = environment(match[1]);
    if (!found || !isTheoremOrCaption(found.env) || !startsLine(page, match.index)) continue;
    const itemIndex = page.charItem[match.index];
    const item = page.items[itemIndex];
    const height = lineHeight(page, itemIndex);
    let top = item.rect.top - height * 0.5;
    let bottom: number;
    if (found.env === "figure") {
      // The figure sits above its caption: from the text above it down to
      // the caption's end.
      // (Starting a little below that text, so no sliver of it shows.)
      const above = textAbove(page, item.rect.top, height * 2);
      top = above ? above + height * 0.6 : page.height * 0.06;
      bottom = blockBelow(page, itemIndex, 4) + height * 0.5;
    } else {
      bottom = blockBelow(page, itemIndex, found.env === "table" ? 30 : 14) + height * 0.5;
    }
    targets.push({
      kind: kindOf(found.env),
      key: `${found.env}:${match[2]}`,
      name: `${found.display} ${match[2]}`,
      pageNumber: page.pageNumber,
      top: fraction(page, top),
      bottom: fraction(page, Math.min(bottom, top + page.height * 0.55)),
      range: [match.index, match.index + match[0].length],
    });
  }

  // "(3.2)" alone at the right end of its line: an equation number.
  page.items.forEach((item, itemIndex) => {
    const label = EQUATION_LABEL.exec(item.text.trim());
    if (!label) return;
    const next = page.items[itemIndex + 1];
    if (next && sameLine(item, next)) return;
    if (item.rect.left + item.rect.width < page.width * 0.6) return;
    const height = lineHeight(page, itemIndex);
    const start = page.charItem.indexOf(itemIndex);
    targets.push({
      kind: "equation",
      key: `equation:${label[1]}`,
      name: `Eq. (${label[1]})`,
      pageNumber: page.pageNumber,
      top: fraction(page, item.rect.top - height * 1.6),
      bottom: fraction(page, item.rect.top + height * 2.6),
      ...(start >= 0 ? { range: [start, start + item.text.trim().length] as [number, number] } : {}),
    });
  });
  return targets;
}

// Numbered sections from the outline ("3.2 Bell states", "Chapter 4: …",
// "Appendix B"), placed at their heading when it can be found on the page.
export function sectionTargets(sections: Section[], pages: IndexedPage[]): XrefTarget[] {
  return sections.flatMap((section): XrefTarget[] => {
    const numbered = /^(?:(?:chapter|section|part|appendix)\s+)?([A-Z]|\d+(?:\.\d+)*)\b[.:]?\s*/i.exec(section.title);
    if (!numbered) return [];
    const page = pages[section.pageNumber - 1];
    let top = 0;
    let range: [number, number] | undefined;
    if (page) {
      const at = page.lower.indexOf(section.title.toLowerCase().slice(0, 40));
      if (at !== -1) {
        const item = page.items[page.charItem[at]];
        if (item) top = fraction(page, item.rect.top - item.rect.height);
        range = [at, at + Math.min(section.title.length, 40)];
      }
    }
    return [
      {
        kind: "section",
        key: `section:${numbered[1]}`,
        name: section.title,
        pageNumber: section.pageNumber,
        top,
        bottom: Math.min(1, top + 0.3),
        ...(range ? { range } : {}),
      },
    ];
  });
}

// ---- Bibliography -----------------------------------------------------------------

export interface BibEntry {
  key?: string; // "12" for numbered styles
  text: string;
  pageNumber: number;
  start: number; // offset of the entry's start in its page's text
  top: number; // fraction of the page height
}

const BIB_HEADING = /^(?:\d+(?:\.\d+)*\.?\s+)?(references|bibliography|works cited|literature cited|literature)$/i;

// Where the bibliography starts: an outline entry named so, else a line that
// says just "References"/"Bibliography" in the back part of the document.
function bibliographyStart(pages: IndexedPage[], sections: Section[]): { page: number; offset: number } | null {
  const section = [...sections].reverse().find((s) => BIB_HEADING.test(s.title.trim()));
  const searchFrom = section ? section.pageNumber - 1 : Math.floor(pages.length * 0.5);
  for (let p = searchFrom; p < pages.length; p += 1) {
    const page = pages[p];
    for (const match of page.text.matchAll(/\b(References|REFERENCES|Bibliography|BIBLIOGRAPHY|Works Cited)\b/g)) {
      if (!startsLine(page, match.index)) continue;
      const item = page.items[page.charItem[match.index]];
      if (item && BIB_HEADING.test(item.text.trim())) return { page: p, offset: match.index + match[0].length };
    }
  }
  return section ? { page: section.pageNumber - 1, offset: 0 } : null;
}

export function parseBibliography(pages: IndexedPage[], sections: Section[]): BibEntry[] {
  const start = bibliographyStart(pages, sections);
  if (!start) return [];

  // Where each entry begins: "[12]" or "12." at the start of a line, or —
  // for author–year styles — "Surname, X." starting a line.
  type Start = { page: IndexedPage; at: number; key?: string };
  const numbered: Start[] = [];
  const named: Start[] = [];
  for (let p = start.page; p < pages.length; p += 1) {
    const page = pages[p];
    const from = p === start.page ? start.offset : 0;
    for (const match of page.text.slice(from).matchAll(/\[(\d{1,4})\]|(?<![\d.])(\d{1,4})\.\s+(?=[A-Z])/g)) {
      const at = from + match.index;
      if (startsLine(page, at)) numbered.push({ page, at, key: match[1] ?? match[2] });
    }
    for (const match of page.text.slice(from).matchAll(/[A-Z][A-Za-z'’-]+,\s+(?:[A-Z]\.|[A-Z][a-z]+)/g)) {
      const at = from + match.index;
      if (startsLine(page, at)) named.push({ page, at });
    }
  }
  const starts = numbered.length >= 2 ? numbered : named;
  return starts.map((entry, i) => {
    const next = starts[i + 1];
    const end = next && next.page === entry.page ? next.at : entry.page.text.length;
    const item = entry.page.items[entry.page.charItem[entry.at]];
    return {
      ...(entry.key ? { key: entry.key } : {}),
      text: entry.page.text.slice(entry.at, end).trim().slice(0, 600),
      pageNumber: entry.page.pageNumber,
      start: entry.at,
      top: item ? fraction(entry.page, item.rect.top - item.rect.height * 0.5) : 0,
    };
  });
}

function citationTarget(entry: BibEntry, name: string, key: string): XrefTarget {
  return {
    kind: "citation",
    key,
    name,
    pageNumber: entry.pageNumber,
    top: entry.top,
    bottom: Math.min(1, entry.top + 0.08),
    range: [entry.start, entry.start + Math.min(entry.text.length, 40)],
    entryText: entry.text,
  };
}

// ---- References -------------------------------------------------------------------

export interface XrefTargets {
  byKey: Map<string, XrefTarget>;
  bibliography: BibEntry[];
}

export function collectTargets(pages: IndexedPage[], sections: Section[]): XrefTargets {
  const byKey = new Map<string, XrefTarget>();
  // The first occurrence wins: a later "Theorem 4.1." restating one isn't
  // where it's defined.
  const add = (target: XrefTarget) => {
    if (!byKey.has(target.key)) byKey.set(target.key, target);
  };
  for (const page of pages) findPageTargets(page).forEach(add);
  sectionTargets(sections, pages).forEach(add);
  return { byKey, bibliography: parseBibliography(pages, sections) };
}

// Case-insensitive ("eq. (3)", "fig. 2", "section 2"), but not inside a word.
const NAMED_REF = new RegExp(`(?<![A-Za-z])(${WORDS})\\s*\\(?(${NUMBER})\\)?`, "gi");
// "(3.2)" after a word that introduces an equation reference.
const BARE_EQUATION = new RegExp(`\\b(?:by|from|in|using|see|and|or|to|with|of|via|cf\\.|into|as)\\s+\\((${NUMBER})\\)`, "gi");
const NUMERIC_CITATION = /\[(\d{1,4}(?:\s*[,–-]\s*\d{1,4})*)\]/g;
const AUTHOR_YEAR =
  /\(([A-Z][A-Za-z'’-]+)(?:\s+et al\.|\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)?,?\s+(\d{4})[a-z]?\)|([A-Z][A-Za-z'’-]+)(?:\s+et al\.|\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)?\s+\((\d{4})[a-z]?\)/g;

function expandNumbers(list: string): string[] {
  return list.split(",").flatMap((part) => {
    const range = /^\s*(\d+)\s*[–-]\s*(\d+)\s*$/.exec(part);
    if (!range) return [part.trim()];
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (to < from || to - from > 30) return [String(from), String(to)];
    return Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
  });
}

export function findPageRefs(page: IndexedPage, targets: XrefTargets): XrefRef[] {
  const refs: XrefRef[] = [];
  const taken: [number, number][] = [];
  const own = new Set(findPageTargets(page).flatMap((t) => (t.range ? [t.range[0]] : [])));
  const add = (start: number, end: number, found: XrefTarget[]) => {
    if (found.length === 0 || own.has(start)) return;
    if (taken.some(([s, e]) => start < e && s < end)) return;
    taken.push([start, end]);
    refs.push({ id: `p${page.pageNumber}-${start}`, pageNumber: page.pageNumber, start, end, text: page.text.slice(start, end), targets: found });
  };

  for (const match of page.text.matchAll(NAMED_REF)) {
    const found = environment(match[1]);
    if (!found) continue;
    const target = targets.byKey.get(`${found.env}:${match[2]}`);
    if (target && target.pageNumber === page.pageNumber && target.range?.[0] === match.index) continue;
    add(match.index, match.index + match[0].length, target ? [target] : []);
  }
  for (const match of page.text.matchAll(BARE_EQUATION)) {
    const at = match.index + match[0].lastIndexOf("(");
    const target = targets.byKey.get(`equation:${match[1]}`);
    add(at, match.index + match[0].length, target ? [target] : []);
  }
  if (targets.bibliography.length) {
    const byNumber = new Map(targets.bibliography.flatMap((e) => (e.key ? [[e.key, e] as const] : [])));
    for (const match of page.text.matchAll(NUMERIC_CITATION)) {
      const found = expandNumbers(match[1]).flatMap((n) => {
        const entry = byNumber.get(n);
        return entry ? [citationTarget(entry, `[${n}]`, `citation:${n}`)] : [];
      });
      add(match.index, match.index + match[0].length, found);
    }
    for (const match of page.text.matchAll(AUTHOR_YEAR)) {
      const surname = match[1] ?? match[3];
      const year = match[2] ?? match[4];
      const entry = targets.bibliography.find((e) => e.text.includes(surname) && e.text.includes(year));
      add(match.index, match.index + match[0].length, entry ? [citationTarget(entry, `${surname} ${year}`, `citation:${surname}-${year}`)] : []);
    }
  }
  return refs.sort((a, b) => a.start - b.start);
}

// The sentence a reference sits in — what "Explain the connection" asks
// about. Bounded by sentence ends, at most `max` characters either side.
export function sentenceAround(text: string, start: number, end: number, max = 300): [number, number] {
  let from = Math.max(0, start - max);
  const before = text.slice(from, start);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
  if (cut !== -1) from += cut + 2;
  const after = text.slice(end, end + max);
  const stop = after.search(/[.!?](?:\s|$)/);
  return [from, stop === -1 ? Math.min(text.length, end + max) : end + stop + 1];
}

// A link's words, from positions estimated along each text run, can take in
// a letter or two of the word beside them ("the key bound f"): trim a
// partial word of at most two letters at either end.
export function trimPartialWords(text: string, [start, end]: [number, number]): [number, number] {
  const isLetter = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  let s = start;
  let e = end;
  if (isLetter(text[e]) && isLetter(text[e - 1])) {
    const space = text.lastIndexOf(" ", e - 1);
    if (space >= s && e - space - 1 <= 2) e = space;
  }
  if (isLetter(text[s - 1]) && isLetter(text[s])) {
    const space = text.indexOf(" ", s);
    if (space !== -1 && space < e && space - s <= 2) s = space + 1;
  }
  while (s < e && text[s] === " ") s += 1;
  while (e > s && text[e - 1] === " ") e -= 1;
  return e > s ? [s, e] : [start, end];
}
