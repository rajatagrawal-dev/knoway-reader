import type { IndexedPage } from "../glossary/textIndex.ts";
import type { TextChunk } from "../text/chunks.ts";
import type { RegionRect } from "./attachments.ts";

// The text around a dive's selection that a reader would reread to
// understand it: more of what leads up to it than what follows, the tail of
// the previous page when the selection sits at the top of one, the start of
// the proof or theorem it's inside, and a neighbor whenever the window opens
// or closes mid-argument ("Therefore…", "…as follows:"). Pure; used only by
// the localWindow and areaContext dive experiments (context.ts).

export interface WindowBudget {
  beforeChars: number; // chunks before the selection's, nearest first
  afterChars: number; // chunks after it
  capChars: number; // the whole window, continuation and statement start included
}

export const WINDOW_BUDGET: WindowBudget = { beforeChars: 1500, afterChars: 600, capChars: 3500 };

// A chunk opening like this continues the one before it.
const CONTINUES_BACK =
  /^(?:therefore|thus|hence|so|then|consequently|it follows|similarly|likewise|in particular|finally|substituting|plugging|combining|by (?:eq|\(|theorem|lemma|proposition|corollary))\b/i;
// A chunk ending like this leads into the one after it.
const LEADS_ON = /(?::|as follows\.?|we (?:have|get|obtain|find)[:.]?|(?:gives|yields):?)\s*$/i;
const MAX_CONTINUATION_STEPS = 2;

const size = (chunks: TextChunk[]) => chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);

// Offsets on the page where a proof or a theorem-like statement begins —
// what a selection inside one gets extended back to. `theoremStarts` come
// from the cross-reference detector (findPageTargets); "Proof." lines are
// found here.
export function statementStarts(page: IndexedPage, theoremStarts: number[]): number[] {
  const proofs = [...page.text.matchAll(/(?:^|(?<=[.:]\s))Proof\b[.:]?/g)].map((match) => match.index);
  return [...theoremStarts, ...proofs].sort((a, b) => a - b);
}

export function localWindow(params: {
  pageChunks: TextChunk[]; // the selection's page, in order
  prevPageChunks: TextChunk[]; // the page before it, in order
  range: [number, number]; // the selection, in its page's text
  statementStarts?: number[]; // see statementStarts()
  budget?: WindowBudget;
}): TextChunk[] {
  const { pageChunks, prevPageChunks, range, budget = WINDOW_BUDGET } = params;
  const [start, end] = range;
  const hits = pageChunks.filter((chunk) => chunk.start < end && start < chunk.end);
  if (hits.length === 0) return [];
  // The document's chunks around the page, in reading order, so "before"
  // can run on into the previous page.
  const sequence = [...prevPageChunks, ...pageChunks];
  let first = sequence.indexOf(hits[0]);
  let last = sequence.indexOf(hits[hits.length - 1]);
  const firstOnPage = prevPageChunks.length;

  // Before: nearest first, within the page — then the previous page's tail
  // only when the selection's own chunk opens the page.
  let before = 0;
  while (first - 1 >= 0) {
    const candidate = sequence[first - 1];
    const crossesPage = first - 1 < firstOnPage;
    if (crossesPage && hits[0] !== pageChunks[0]) break;
    if (before + candidate.text.length > budget.beforeChars) break;
    before += candidate.text.length;
    first -= 1;
  }
  let after = 0;
  while (last + 1 < sequence.length) {
    const candidate = sequence[last + 1];
    if (after + candidate.text.length > budget.afterChars) break;
    after += candidate.text.length;
    last += 1;
  }

  const total = () => size(sequence.slice(first, last + 1));

  // Inside a proof or theorem that starts earlier on this page: extend back
  // to its start, if that still fits.
  const starts = (params.statementStarts ?? []).filter((at) => at <= start);
  const enclosing = starts[starts.length - 1];
  if (enclosing !== undefined) {
    const at = pageChunks.findIndex((chunk) => chunk.start <= enclosing && enclosing < chunk.end);
    const index = at === -1 ? -1 : firstOnPage + at;
    if (index !== -1 && index < first && size(sequence.slice(index, last + 1)) <= budget.capChars) first = index;
  }

  // Continuation, up to the cap.
  for (let step = 0; step < MAX_CONTINUATION_STEPS; step += 1) {
    const opener = sequence[first];
    const previous = sequence[first - 1];
    if (!previous || !CONTINUES_BACK.test(opener.text.trim())) break;
    if (total() + previous.text.length > budget.capChars) break;
    first -= 1;
  }
  for (let step = 0; step < MAX_CONTINUATION_STEPS; step += 1) {
    const closer = sequence[last];
    const next = sequence[last + 1];
    if (!next || !LEADS_ON.test(closer.text.trim())) break;
    if (total() + next.text.length > budget.capChars) break;
    last += 1;
  }

  // The cap holds even if the budgets alone overshoot it: drop from the far
  // ends, keeping the selection's own chunks.
  const hitFirst = sequence.indexOf(hits[0]);
  const hitLast = sequence.indexOf(hits[hits.length - 1]);
  while (total() > budget.capChars && (first < hitFirst || last > hitLast)) {
    if (hitFirst - first >= last - hitLast && first < hitFirst) first += 1;
    else last -= 1;
  }
  return sequence.slice(first, last + 1);
}

// ---- Area selections ------------------------------------------------------------

// A chunk's vertical extent on its page, in page units.
export function chunkVerticalSpan(page: IndexedPage, chunk: TextChunk): { top: number; bottom: number } | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = chunk.start; i < chunk.end; i += 1) {
    const item = page.items[page.charItem[i]];
    if (!item) continue;
    top = Math.min(top, item.rect.top);
    bottom = Math.max(bottom, item.rect.top + item.rect.height);
  }
  return Number.isFinite(top) ? { top, bottom } : null;
}

// For a region with no text of its own (a figure, or math drawn without a
// text layer): a stand-in range to center the window on — the chunk just
// above the region, else the one just below.
export function regionAnchorRange(page: IndexedPage, pageChunks: TextChunk[], rect: RegionRect): [number, number] | null {
  const top = (rect.y1 / rect.height) * page.height;
  const bottom = (rect.y2 / rect.height) * page.height;
  let above: { chunk: TextChunk; bottom: number } | null = null;
  let below: { chunk: TextChunk; top: number } | null = null;
  for (const chunk of pageChunks) {
    const span = chunkVerticalSpan(page, chunk);
    if (!span) continue;
    if (span.bottom <= top + 1 && (!above || span.bottom > above.bottom)) above = { chunk, bottom: span.bottom };
    if (span.top >= bottom - 1 && (!below || span.top < below.top)) below = { chunk, top: span.top };
  }
  const anchor = above?.chunk ?? below?.chunk;
  return anchor ? [anchor.start, anchor.end] : null;
}
