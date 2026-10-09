import type { DocumentTextIndex, IndexedPage } from "../glossary/textIndex.ts";

// The document cut into small, citable passages: what retrieval ranks and
// what the model sees as numbered sources. Small (a few sentences) so a
// citation points somewhere specific and a relevant passage doesn't drag
// unrelated text into the prompt. Chunks never cross a page, and carry
// offsets into their page's normalized text, so a chunk — or any sentence
// in it — maps back to on-page rectangles through matchPosition.

export interface TextChunk {
  id: string; // "p12-3": page 12, fourth chunk on the page
  pageNumber: number;
  start: number; // [start, end) into the page's `text`
  end: number;
  text: string;
}

export const CHUNK_MIN_CHARS = 400;
export const CHUNK_MAX_CHARS = 700;
// A page's short tail joins the chunk before it rather than standing alone,
// as long as the result isn't much over the maximum.
const TAIL_MIN_CHARS = 150;
const TAIL_MERGE_MAX_CHARS = 850;

// Words whose trailing period doesn't end a sentence ("Fig. 3", "et al.
// (2020)", "e.g. the"). Lowercased, without the period.
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "cf", "vs", "al", "fig", "figs", "eq", "eqs", "sec", "secs", "ch", "chap",
  "no", "nos", "vol", "pp", "p", "ref", "refs", "thm", "def", "prop", "lem", "cor", "approx",
  "dr", "mr", "mrs", "ms", "prof", "st", "resp", "viz", "ca",
]);

// Offsets in `text` just past each sentence end (after the whitespace that
// follows it), in order. A sentence ends at . ! or ? (plus any closing
// quote/bracket) followed by whitespace and then something that can start
// a sentence.
export function sentenceBoundaries(text: string): number[] {
  const boundaries: number[] = [];
  const pattern = /[.!?]["'”’)\]]*\s+(?=[\p{Lu}\p{N}("'“‘[$\\])/gu;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (text[at] === ".") {
      const word = /([\p{L}.]+)$/u.exec(text.slice(Math.max(0, at - 12), at))?.[1]?.toLowerCase();
      // An abbreviation, or a single initial ("J. Smith").
      if (word && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word))) continue;
    }
    boundaries.push(at + match[0].length);
  }
  return boundaries;
}

// Where to cut an over-long sentence: the last space at or before `limit`
// (past `from`), or `limit` itself if there's none.
function wordBreak(text: string, from: number, limit: number): number {
  const space = text.lastIndexOf(" ", limit);
  return space > from ? space + 1 : limit;
}

export function chunkPage(page: IndexedPage): TextChunk[] {
  const { text } = page;
  // Sentence spans, with any single sentence longer than a chunk split at
  // word breaks (formula runs, tables, and run-on extraction produce these).
  const spans: [number, number][] = [];
  let from = 0;
  for (const end of [...sentenceBoundaries(text), text.length]) {
    while (end - from > CHUNK_MAX_CHARS) {
      const cut = wordBreak(text, from, from + CHUNK_MAX_CHARS);
      spans.push([from, cut]);
      from = cut;
    }
    if (end > from) spans.push([from, end]);
    from = end;
  }

  // Pack sentences greedily: keep adding while under the minimum, and while
  // the next one still fits under the maximum.
  const ranges: [number, number][] = [];
  let current: [number, number] | null = null;
  for (const [start, end] of spans) {
    if (!current) current = [start, end];
    else if (current[1] - current[0] < CHUNK_MIN_CHARS || end - current[0] <= CHUNK_MAX_CHARS) current[1] = end;
    else {
      ranges.push(current);
      current = [start, end];
    }
  }
  if (current) {
    const last = ranges[ranges.length - 1];
    if (last && current[1] - current[0] < TAIL_MIN_CHARS && current[1] - last[0] <= TAIL_MERGE_MAX_CHARS) last[1] = current[1];
    else ranges.push(current);
  }

  const chunks: TextChunk[] = [];
  for (const [rawStart, rawEnd] of ranges) {
    // Trim surrounding whitespace so a chunk's text starts and ends on a
    // character (and its flashed highlight doesn't include a stray gap).
    let start = rawStart;
    let end = rawEnd;
    while (start < end && text[start] === " ") start += 1;
    while (end > start && text[end - 1] === " ") end -= 1;
    if (end <= start) continue;
    chunks.push({
      id: `p${page.pageNumber}-${chunks.length}`,
      pageNumber: page.pageNumber,
      start,
      end,
      text: text.slice(start, end),
    });
  }
  return chunks;
}

export function chunkDocument(index: DocumentTextIndex): TextChunk[] {
  return index.pages.flatMap(chunkPage);
}
