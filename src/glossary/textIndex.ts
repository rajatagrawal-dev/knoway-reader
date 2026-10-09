import type { LTWHP, PdfExtractedPage, PdfTextItem, Scaled, ScaledPosition } from "react-pdf-highlighter-plus";

// A whole-document, searchable copy of the PDF's text layer — what lets a
// glossary lookup find every occurrence of a term locally, in milliseconds,
// instead of asking the model to search. Pure (type-only imports) so it can
// be unit-tested without a PDF; the pages come from the library's
// extractPageTextItems (see job.ts).

export interface IndexedPage {
  pageNumber: number;
  width: number;
  height: number;
  items: PdfTextItem[];
  text: string; // normalized page text, original case
  lower: string; // `text` lowercased char-for-char: same length, same indices
  charItem: number[]; // per char of `text`: index into `items`, -1 for an inserted separator
  charOffset: number[]; // per char of `text`: offset within that item's own text
}

export interface DocumentTextIndex {
  pages: IndexedPage[];
}

export interface TermMatch {
  page: IndexedPage;
  start: number; // [start, end) into page.text
  end: number;
  // A related word form rather than the term itself (see findRelatedMatches).
  related?: boolean;
}

// Running heads/feet ("CHAPTER 3. ENTANGLEMENT" atop every page) would
// otherwise turn up as a "reference" on every page of the chapter. A line in
// the top/bottom margin band that repeats (digits aside) on this many pages
// is treated as one, and so is a margin line that's only a page number.
const MARGIN_FRACTION = 0.08;
const RUNNING_LINE_MIN_PAGES = 3;

function marginLines(page: PdfExtractedPage): PdfTextItem[][] {
  const lines = new Map<number, PdfTextItem[]>();
  for (const item of page.textItems) {
    const { top, height } = item.rect;
    const inMargin = top < page.height * MARGIN_FRACTION || top + height > page.height * (1 - MARGIN_FRACTION);
    if (!inMargin) continue;
    const key = Math.round(top);
    const line = lines.get(key);
    if (line) line.push(item);
    else lines.set(key, [item]);
  }
  return [...lines.values()];
}

function runningLineKey(line: PdfTextItem[]): string {
  return line
    .map((item) => item.text)
    .join(" ")
    .toLowerCase()
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findRunningItems(pages: PdfExtractedPage[]): Set<PdfTextItem> {
  const linesByPage = pages.map((page) => marginLines(page).map((line) => ({ line, key: runningLineKey(line) })));
  const pagesPerKey = new Map<string, Set<number>>();
  linesByPage.forEach((lines, pageIndex) => {
    for (const { key } of lines) {
      if (!pagesPerKey.has(key)) pagesPerKey.set(key, new Set());
      pagesPerKey.get(key)!.add(pageIndex);
    }
  });
  const running = new Set<PdfTextItem>();
  for (const lines of linesByPage) {
    for (const { line, key } of lines) {
      if (key === "" || (pagesPerKey.get(key)?.size ?? 0) >= RUNNING_LINE_MIN_PAGES) {
        line.forEach((item) => running.add(item));
      }
    }
  }
  return running;
}

// Per-character normalization shared by page text and search terms: NFKC
// expands ligatures (ﬁ → fi) and compatibility forms, curly quotes are
// straightened, soft hyphens and NULs (pdf.js emits one for an unmapped
// glyph) are dropped, and any whitespace becomes a plain space.
function normalizeChar(c: string): string {
  if (c === "\u00AD" || c === "\u0000") return "";
  if (/\s/.test(c)) return " ";
  if (c === "\u2018" || c === "\u2019" || c === "\u02BC") return "'";
  if (c === "\u201C" || c === "\u201D") return '"';
  return c.normalize("NFKC");
}

function buildPage(page: PdfExtractedPage, skip: Set<PdfTextItem>): IndexedPage {
  const items = page.textItems.filter((item) => item.text && !skip.has(item));
  const textChars: string[] = [];
  const lowerChars: string[] = [];
  const charItem: number[] = [];
  const charOffset: number[] = [];

  const push = (ch: string, itemIndex: number, offset: number) => {
    if (ch === " " && (textChars.length === 0 || textChars[textChars.length - 1] === " ")) return;
    const lower = ch.toLowerCase();
    textChars.push(ch);
    lowerChars.push(lower.length === 1 ? lower : ch);
    charItem.push(itemIndex);
    charOffset.push(offset);
  };
  const pop = () => {
    textChars.pop();
    lowerChars.pop();
    charItem.pop();
    charOffset.pop();
  };

  items.forEach((item, itemIndex) => {
    const prev = items[itemIndex - 1];
    // pdf.js splits text into runs that don't line up with words: a run can
    // end mid-word on the same line, and the last word of a line abuts the
    // next line's first with no space between them. Decide from geometry
    // whether a word break separates this run from the previous one.
    if (prev && textChars.length > 0 && textChars[textChars.length - 1] !== " " && !/^\s/.test(item.text)) {
      const lineHeight = Math.min(prev.rect.height, item.rect.height) || item.rect.height || 1;
      const sameLine = Math.abs(prev.rect.top - item.rect.top) < lineHeight * 0.5;
      const gap = item.rect.left - (prev.rect.left + prev.rect.width);
      const previousText = textChars.slice(-2).join("");
      if (sameLine) {
        if (gap > lineHeight * 0.15) push(" ", -1, 0);
      } else if (/\p{L}-$/u.test(previousText) && /^\p{Ll}/u.test(item.text)) {
        pop(); // "entan-" / "glement" → "entanglement"
      } else {
        push(" ", -1, 0);
      }
    }
    for (let offset = 0; offset < item.text.length; offset += 1) {
      for (const ch of normalizeChar(item.text[offset])) push(ch, itemIndex, offset);
    }
  });

  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    items,
    text: textChars.join(""),
    lower: lowerChars.join(""),
    charItem,
    charOffset,
  };
}

export function buildTextIndex(pages: PdfExtractedPage[]): DocumentTextIndex {
  const running = findRunningItems(pages);
  return { pages: pages.map((page) => buildPage(page, running)) };
}

// ---- Terms ---------------------------------------------------------------

const WORD_SPLIT = /[\s\-\u2010-\u2015]+/;
// Between the words of a multi-word term: any mix of spaces and hyphens, or
// nothing — so "well-known", "well known", and a dehyphenated line break
// ("wellknown") all match each other.
const WORD_JOINER = "[\\s\\-\\u2010-\\u2015]*";

function normalizeText(value: string): string {
  return [...value].map(normalizeChar).join("");
}

// A selection as it becomes a glossary term: normalized, whitespace
// collapsed, and trimmed of the punctuation/quotes a drag-select tends to
// pick up at either end.
export function cleanTerm(raw: string): string {
  return normalizeText(raw)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s"'([{<.,;:!?*]+|[\s"')\]}>.,;:!?*]+$/g, "");
}

// Short all-caps terms (acronyms) are matched case-sensitively — otherwise
// "IT" or "US" would match every "it"/"us" in the book.
function isAcronym(term: string): boolean {
  return term.length <= 6 && !/\p{Ll}/u.test(term) && (term.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
}

function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// Identity for deduping glossary entries: "Qubits", "qubit" and "qubit's"
// are one entry.
export function termKey(term: string): string {
  const words = cleanTerm(term).toLowerCase().replace(/'s$/, "").split(WORD_SPLIT).filter(Boolean);
  if (words.length === 0) return "";
  words[words.length - 1] = singular(words[words.length - 1]);
  return words.join(" ");
}

// A glossary is for terms, not passages.
export const MAX_TERM_WORDS = 8;
export const MAX_TERM_LENGTH = 80;

export function isGlossaryCandidate(selection: string): boolean {
  const term = cleanTerm(selection);
  return term.length > 0 && term.length <= MAX_TERM_LENGTH && term.split(" ").length <= MAX_TERM_WORDS;
}

// Syntax characters only: the `u` flag rejects escapes of anything else.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The last word also matches its singular/plural forms.
function inflect(word: string, acronym: boolean): string {
  if (acronym) return `${escapeRegExp(word)}s?`;
  if (!/^\p{L}{3,}$/u.test(word)) return escapeRegExp(word);
  if (word.endsWith("ies")) return `${escapeRegExp(word.slice(0, -3))}(?:y|ies)`;
  if (/[^aeiou]y$/.test(word)) return `${escapeRegExp(word.slice(0, -1))}(?:y|ies)`;
  if (/(ss|us|is)$/.test(word)) return `${escapeRegExp(word)}(?:es)?`;
  if (word.endsWith("s")) return `${escapeRegExp(word.slice(0, -1))}(?:s|es)?`;
  return `${escapeRegExp(word)}(?:s|es)?`;
}

export function buildTermRegex(term: string): { regex: RegExp; caseSensitive: boolean } | null {
  const cleaned = cleanTerm(term);
  const caseSensitive = isAcronym(cleaned);
  const words = (caseSensitive ? cleaned : cleaned.toLowerCase()).split(WORD_SPLIT).filter(Boolean);
  const last = words.pop();
  if (last === undefined) return null;
  const body = [...words.map(escapeRegExp), inflect(last, caseSensitive)].join(WORD_JOINER);
  return {
    regex: new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?:'s)?(?![\\p{L}\\p{N}])`, "gu"),
    caseSensitive,
  };
}

function matchRegex(index: DocumentTextIndex, regex: RegExp, caseSensitive: boolean, related?: true): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const page of index.pages) {
    const haystack = caseSensitive ? page.text : page.lower;
    for (const m of haystack.matchAll(regex)) {
      matches.push({ page, start: m.index, end: m.index + m[0].length, ...(related ? { related } : {}) });
    }
  }
  return matches;
}

// Every occurrence of the term, in document order.
export function findTermMatches(index: DocumentTextIndex, term: string): TermMatch[] {
  const built = buildTermRegex(term);
  return built ? matchRegex(index, built.regex, built.caseSensitive) : [];
}

// Every occurrence of `query` as plain, case-insensitive text (no word
// boundaries or inflections, unlike a glossary term), in document order —
// what the search panel lists. Normalized like the page text, so a
// ligature or curly quote in either side still matches.
export function findTextMatches(index: DocumentTextIndex, query: string): TermMatch[] {
  const needle = normalizeText(query).replace(/\s+/g, " ").trim().toLowerCase();
  if (!needle) return [];
  const matches: TermMatch[] = [];
  for (const page of index.pages) {
    let from = 0;
    for (let at = page.lower.indexOf(needle, from); at !== -1; at = page.lower.indexOf(needle, from)) {
      matches.push({ page, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return matches;
}

// Derivational endings stripped to reach a stem shared by related forms:
// "entanglement" → "entangl" (entangle, entangled, entangling),
// "superposition" → "superpos" (superposed).
const DERIVATIONAL_SUFFIX = /(?:ments?|ness|ities|ity|ations?|itions?|tions?|ings?|ed|es|s)$/;
const MIN_STEM_LENGTH = 5; // shorter stems match too many unrelated words

// A regex for related forms of the term (its own forms included), or null
// when its stem would be too short to be specific.
function buildRelatedRegex(term: string): RegExp | null {
  const cleaned = cleanTerm(term);
  if (isAcronym(cleaned)) return null;
  const words = cleaned.toLowerCase().split(WORD_SPLIT).filter(Boolean);
  const last = words.pop();
  if (!last || !/^\p{L}+$/u.test(last)) return null;
  const stem = last.replace(DERIVATIONAL_SUFFIX, "").replace(/e$/, "");
  if (stem.length < MIN_STEM_LENGTH) return null;
  const body = [...words.map(escapeRegExp), `${escapeRegExp(stem)}\\p{L}{0,8}`].join(WORD_JOINER);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, "gu");
}

// Occurrences of related forms of the term — but not the term itself — for
// finding where the document defines it: a book may define "entanglement"
// only as "…is an entangled state". Used when choosing excerpts for the
// model, not for the reference list, which stays to the term as selected.
export function findRelatedMatches(index: DocumentTextIndex, term: string): TermMatch[] {
  const regex = buildRelatedRegex(term);
  if (!regex) return [];
  const exact = buildTermRegex(term);
  return matchRegex(index, regex, false, true).filter(
    (match) => !exact || !new RegExp(`^(?:${exact.regex.source})$`, "u").test(match.page.lower.slice(match.start, match.end)),
  );
}

// ---- Marking glossary terms on a page ------------------------------------

export interface TermMatcher {
  exact: RegExp;
  caseSensitive: boolean;
  related: RegExp | null;
}

export function buildTermMatcher(term: string): TermMatcher | null {
  const exact = buildTermRegex(term);
  return exact ? { exact: exact.regex, caseSensitive: exact.caseSensitive, related: buildRelatedRegex(term) } : null;
}

export interface PageTermMark extends TermMatch {
  id: string; // whose term this is (a glossary entry id)
}

// Every place on one page where any of `terms` appears, as itself or a
// related form, without overlaps: where two terms overlap ("density
// operator" / "operator"), the one starting first wins, then the longer
// one, then an exact match over a related form.
export function findTermMarksOnPage(page: IndexedPage, terms: { id: string; matcher: TermMatcher }[]): PageTermMark[] {
  const candidates: PageTermMark[] = [];
  for (const { id, matcher } of terms) {
    const exactHaystack = matcher.caseSensitive ? page.text : page.lower;
    for (const m of exactHaystack.matchAll(matcher.exact)) {
      candidates.push({ id, page, start: m.index, end: m.index + m[0].length });
    }
    if (matcher.related) {
      for (const m of page.lower.matchAll(matcher.related)) {
        candidates.push({ id, page, start: m.index, end: m.index + m[0].length, related: true });
      }
    }
  }
  candidates.sort(
    (a, b) => a.start - b.start || b.end - a.end || Number(a.related ?? false) - Number(b.related ?? false),
  );
  const marks: PageTermMark[] = [];
  for (const candidate of candidates) {
    const last = marks[marks.length - 1];
    if (!last || candidate.start >= last.end) marks.push(candidate);
  }
  return marks;
}

// Adds `extra` matches (e.g. an alias's) to `base`, skipping any that
// overlap one already there, and returns the union in document order.
export function mergeMatches(base: TermMatch[], extra: TermMatch[]): TermMatch[] {
  const merged = [...base];
  for (const candidate of extra) {
    const overlaps = merged.some(
      (m) => m.page === candidate.page && m.start < candidate.end && candidate.start < m.end,
    );
    if (!overlaps) merged.push(candidate);
  }
  return merged.sort((a, b) => a.page.pageNumber - b.page.pageNumber || a.start - b.start);
}

export function matchId(match: TermMatch): string {
  return `p${match.page.pageNumber}-${match.start}`;
}

// ---- Snippets and positions ----------------------------------------------

// The match plus up to `radius` characters either side, cut back to whole
// words, with an ellipsis wherever the page text continues.
export function snippetAround(match: TermMatch, radius: number): { before: string; match: string; after: string } {
  const { text } = match.page;
  let from = Math.max(0, match.start - radius);
  let to = Math.min(text.length, match.end + radius);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space !== -1 && space < match.start) from = space + 1;
  }
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > match.end) to = space;
  }
  return {
    before: (from > 0 ? "…" : "") + text.slice(from, match.start),
    match: text.slice(match.start, match.end),
    after: text.slice(match.end, to) + (to < text.length ? "…" : ""),
  };
}

// The match's on-page rectangles, as a highlight position: each text run it
// spans contributes the proportional slice of its rect covering the matched
// characters (pdf.js gives rects per run, not per glyph), merged per line.
export function matchPosition(match: TermMatch): ScaledPosition | null {
  const { page } = match;
  const spans = new Map<number, [number, number]>();
  for (let i = match.start; i < match.end; i += 1) {
    const itemIndex = page.charItem[i];
    if (itemIndex < 0) continue;
    const offset = page.charOffset[i];
    const span = spans.get(itemIndex);
    if (!span) spans.set(itemIndex, [offset, offset + 1]);
    else {
      span[0] = Math.min(span[0], offset);
      span[1] = Math.max(span[1], offset + 1);
    }
  }

  const rects: LTWHP[] = [];
  for (const [itemIndex, [from, to]] of spans) {
    const item = page.items[itemIndex];
    const { left, top, width, height } = item.rect;
    const length = item.text.length;
    if (!(width > 0) || !(height > 0) || length === 0) continue;
    rects.push({
      left: left + (from / length) * width,
      top,
      width: ((to - from) / length) * width,
      height,
      pageNumber: page.pageNumber,
    });
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const merged: LTWHP[] = [];
  for (const rect of rects) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.top - rect.top) < Math.max(2, rect.height * 0.4)) {
      const right = Math.max(last.left + last.width, rect.left + rect.width);
      last.left = Math.min(last.left, rect.left);
      last.width = right - last.left;
      last.height = Math.max(last.height, rect.height);
    } else {
      merged.push({ ...rect });
    }
  }
  if (merged.length === 0) return null;

  const toScaled = (rect: LTWHP): Scaled => ({
    x1: rect.left,
    y1: rect.top,
    x2: rect.left + rect.width,
    y2: rect.top + rect.height,
    width: page.width,
    height: page.height,
    pageNumber: page.pageNumber,
  });
  const scaledRects = merged.map(toScaled);
  return {
    boundingRect: {
      x1: Math.min(...scaledRects.map((r) => r.x1)),
      y1: Math.min(...scaledRects.map((r) => r.y1)),
      x2: Math.max(...scaledRects.map((r) => r.x2)),
      y2: Math.max(...scaledRects.map((r) => r.y2)),
      width: page.width,
      height: page.height,
      pageNumber: page.pageNumber,
    },
    rects: scaledRects,
  };
}

// ---- Choosing excerpts for the model -------------------------------------

// Phrasings that introduce or define a term, checked just after ("X is…",
// "X (Y) refers to…") and just before ("…known as X", "we call X") a match.
// "X is a …" is weak evidence on its own — books say "entanglement is a key
// element…" far more often than they define it — so it scores below an
// explicit defining phrase anywhere in the same sentence ("we say that a
// state … is an entangled state").
const DEFINES_AFTER =
  /^(?:\s*\([^)]{0,60}\))?\s*,?\s*(?:(?:is|are)\s+(?:an?|the)|refers? to|means?|denotes?|describes?|represents?|stands? for|is defined as|is called|i\.e\.|that is)\b/;
const DEFINES_BEFORE =
  /(?:called|known as|termed|named|defined? as|definition of|we (?:call|say)|so-called|the (?:notion|concept|term) of|denoted by)\s+(?:an?\s+|the\s+)?["']?$/;
const DEFINING_SENTENCE =
  /\b(?:we say|(?:is|are) said to be|(?:is|are) called|(?:is|are) defined|we define|defined as|known as|referred to as|we call|we refer to)\b/;
const CLASSIFIES_BEFORE = /\b(?:is|are)\s+(?:an?|the)\s+$/;

const SENTENCE_REACH = 300; // max chars scanned either side for the sentence's bounds

// The rest of the match's sentence before and after it (approximately:
// bounded by ". ", "? " or "! ").
function sentenceAround(match: TermMatch): { before: string; after: string } {
  const { lower } = match.page;
  let before = lower.slice(Math.max(0, match.start - SENTENCE_REACH), match.start);
  const cut = Math.max(before.lastIndexOf(". "), before.lastIndexOf("? "), before.lastIndexOf("! "));
  if (cut !== -1) before = before.slice(cut + 2);
  let after = lower.slice(match.end, match.end + SENTENCE_REACH);
  const end = after.search(/[.!?](?:\s|$)/);
  if (end !== -1) after = after.slice(0, end + 1);
  return { before, after };
}

// How much a match's sentence reads as defining or introducing the term,
// from its phrasing alone.
function definitionScore(match: TermMatch): number {
  const { before, after } = sentenceAround(match);
  let score = 0;
  if (DEFINING_SENTENCE.test(`${before} ${after}`)) score += 5;
  if (DEFINES_BEFORE.test(before.slice(-50))) score += 4;
  if (DEFINES_AFTER.test(after.slice(0, 60))) score += 3;
  if (CLASSIFIES_BEFORE.test(before.slice(-20))) score += 2;
  return score;
}

// A defining phrase before, after or around the match; "…is a X" alone
// isn't enough.
const DEFINITION_MIN_SCORE = 3;

// The match (of `matches`, in document order) that most likely defines the
// term — the earliest on a tie — or undefined if none reads like a
// definition.
export function findDefiningMatch(matches: TermMatch[]): TermMatch | undefined {
  let best: TermMatch | undefined;
  let bestScore = DEFINITION_MIN_SCORE - 1;
  for (const match of matches) {
    const score = definitionScore(match);
    if (score > bestScore) {
      best = match;
      bestScore = score;
    }
  }
  return best;
}

const EXCERPT_MIN_GAP = 400; // chars between two excerpts from one page

export function selectExcerpts(matches: TermMatch[], selectionPage: number, max: number): TermMatch[] {
  const scored = matches.map((match, order) => {
    let score = definitionScore(match);
    if (!match.related) score += 1;
    if (match.page.pageNumber === selectionPage) score += 3;
    if (order === 0) score += 2;
    return { match, score, order };
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const chosen: TermMatch[] = [];
  for (const { match } of scored) {
    if (chosen.length >= max) break;
    const tooClose = chosen.some(
      (other) => other.page === match.page && Math.abs(other.start - match.start) < EXCERPT_MIN_GAP,
    );
    if (!tooClose) chosen.push(match);
  }
  return chosen.sort((a, b) => a.page.pageNumber - b.page.pageNumber || a.start - b.start);
}
