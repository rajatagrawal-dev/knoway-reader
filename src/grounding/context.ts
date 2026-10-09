import { findTextMatches, type DocumentTextIndex } from "../glossary/textIndex.ts";
import type { TextChunk } from "../text/chunks.ts";
import { formatSectionPath, sectionPathAt, type Section } from "../text/sections.ts";
import { findPageTargets, sentenceAround, type XrefRef, type XrefTargets } from "../xref/detect.ts";
import { regionTextRange, type RegionRect } from "./attachments.ts";
import { linkedSources, LINK_BUDGET, regionCaptionSources, secondHopSources, sourceKey, type LinkTerm } from "./links.ts";
import { localWindow, regionAnchorRange, statementStarts } from "./localWindow.ts";
import { backMatterPages, diveQuery, diveWeights, sectionRangeAt } from "./priors.ts";
import { selectRelevant, scoreChunks, type Bm25Index } from "./retrieval.ts";
import type { SourceRef, SourceVia } from "./types.ts";

// Which passages a Deep Dive request sends: the text around the selection,
// plus whatever elsewhere in the document is clearly relevant to it — so a
// dive can say "defined on p. 12" instead of guessing. Sized by relevance
// within the budget (roadmap §5.2), and labeled S1…Sn in document order.

export interface ContextBudget {
  typicalChars: number;
  ceilingChars: number;
}

export const DIVE_BUDGET: ContextBudget = { typicalChars: 4000, ceilingChars: 40000 };

// A selection this close to its chunk's edge brings the neighboring chunk
// along: the sentence it continues, or the one it leads into.
const EDGE_CHARS = 80;
const PROBE_CHARS = 60;

export interface DiveSourceInput {
  index: DocumentTextIndex;
  chunks: TextChunk[];
  bm25: Bm25Index;
  selection: string;
  pageNumber: number | null; // root dives: the page the selection is on
  question?: string; // the reader's latest follow-up, if any
  inherited?: SourceRef[]; // nested dives: the sources the parent answer cited
  attached?: SourceRef[]; // passages the reader added to this question (grounding/attachments.ts)
  extraQuery?: string; // more words to search with (the attached text)
  // Read only by the context experiments (DiveContextStrategy below); each
  // optional, and a missing one just leaves that signal out.
  sections?: Section[];
  refsByPage?: Map<number, XrefRef[]>; // xrefIndex.refsByPage
  targets?: XrefTargets; // xrefIndex.targets
  terms?: LinkTerm[]; // glossary terms, located where the document defines them
  region?: RegionRect; // area dives: the region selected
  anchor?: SourceRef[]; // nested dives: the passage the tree started from
  rootPage?: number; // nested dives: the page the tree started from
}

// Which of the Deep Dive context experiments (deepdive/experiments.ts) to
// apply. All off — the default — is the original selection, unchanged; each
// can be switched on alone, so the eval can compare them.
export interface DiveContextStrategy {
  localWindow?: boolean;
  linkedSources?: boolean;
  rankingPriors?: boolean;
  areaContext?: boolean;
  nestedContext?: boolean;
}

// With any experiment on, retrieval gets its own budget instead of what the
// local passages leave of DIVE_BUDGET's typical size.
export const RETRIEVAL_TYPICAL_CHARS = 2500;
const ANCHOR_MAX_SOURCES = 2;
const ANCHOR_MAX_CHARS = 1500;
const AREA_QUERY_CHARS = 400;

function fromChunk(chunk: TextChunk): SourceRef {
  return { label: "", pageNumber: chunk.pageNumber, start: chunk.start, end: chunk.end, text: chunk.text, chunkId: chunk.id };
}

// Where the selection sits on its page, as [start, end) into the page text.
// Selected text doesn't always match the extracted text exactly (a word
// hyphenated across a line, a ligature), so this tries the start of the
// selection, then its end.
export function locateSelection(index: DocumentTextIndex, pageNumber: number, selection: string): [number, number] | null {
  const page = index.pages[pageNumber - 1];
  if (!page) return null;
  const onPage: DocumentTextIndex = { pages: [page] };
  const text = selection.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const whole = findTextMatches(onPage, text)[0];
  if (whole) return [whole.start, whole.end];
  const head = findTextMatches(onPage, text.slice(0, PROBE_CHARS))[0];
  const tail = findTextMatches(onPage, text.slice(-PROBE_CHARS))[0];
  if (head && tail && tail.end > head.start) return [head.start, tail.end];
  if (head) return [head.start, Math.min(page.text.length, head.start + text.length)];
  if (tail) return [Math.max(0, tail.end - text.length), tail.end];
  return null;
}

// The chunks holding the selection (and a neighbor when it sits at an
// edge). If the selection can't be found in the text — an area selection
// with no text, or text the extraction mangled — the page's chunk that best
// matches it stands in.
function localChunks(input: DiveSourceInput, pageNumber: number): TextChunk[] {
  const pageChunks = input.chunks.filter((chunk) => chunk.pageNumber === pageNumber);
  if (pageChunks.length === 0) return [];
  const range = locateSelection(input.index, pageNumber, input.selection);
  if (!range) {
    if (!input.selection.trim()) return pageChunks.slice(0, 2);
    const scores = scoreChunks(input.bm25, input.selection);
    const best = pageChunks
      .map((chunk) => ({ chunk, score: scores[input.chunks.indexOf(chunk)] ?? 0 }))
      .sort((a, b) => b.score - a.score)[0];
    return [best.chunk];
  }
  const [start, end] = range;
  const hit = pageChunks.filter((chunk) => chunk.start < end && start < chunk.end);
  if (hit.length === 0) return [];
  const first = pageChunks.indexOf(hit[0]);
  const last = pageChunks.indexOf(hit[hit.length - 1]);
  const withNeighbors = [...hit];
  if (first > 0 && start - hit[0].start < EDGE_CHARS) withNeighbors.unshift(pageChunks[first - 1]);
  if (last < pageChunks.length - 1 && hit[hit.length - 1].end - end < EDGE_CHARS) withNeighbors.push(pageChunks[last + 1]);
  return withNeighbors;
}

// Document order, S1…Sn.
export function labelSources(sources: SourceRef[]): SourceRef[] {
  return [...sources]
    .sort((a, b) => a.pageNumber - b.pageNumber || a.start - b.start)
    .map((source, i) => ({ ...source, label: `S${i + 1}` }));
}

export function buildDiveSources(
  input: DiveSourceInput,
  budget: ContextBudget = DIVE_BUDGET,
  strategy: DiveContextStrategy = {},
): SourceRef[] {
  const chosen: SourceRef[] = [];
  const taken = new Set<string>();
  const add = (source: SourceRef) => {
    const key = sourceKey(source);
    if (taken.has(key)) return;
    taken.add(key);
    chosen.push(source);
  };
  const tagged = (source: SourceRef, via: SourceVia): SourceRef => ({ ...source, via: source.via ?? via });

  input.attached?.forEach((source) => add(tagged(source, "attached")));
  const notAttached = (source: SourceRef) =>
    !input.attached?.some((a) => a.pageNumber === source.pageNumber && a.end > a.start && a.start < source.end && source.start < a.end);

  const nested = input.pageNumber === null;
  const area = Boolean(strategy.areaContext && input.region && !nested);
  const enriched =
    strategy.localWindow || strategy.linkedSources || strategy.rankingPriors || area || (strategy.nestedContext && nested);

  // The text around the selection.
  let window: LocalWindow | null = null;
  if (input.pageNumber !== null) {
    window = strategy.localWindow || area ? windowAround(input, input.pageNumber, area) : null;
    (window?.chunks ?? localChunks(input, input.pageNumber))
      .map((chunk) => tagged(fromChunk(chunk), "local"))
      .filter(notAttached)
      .forEach(add);
  }
  input.inherited?.filter(notAttached).forEach((source) => add(tagged(source, "inherited")));

  // A nested dive keeps the passage its tree started from in view.
  if (nested && strategy.nestedContext && input.anchor?.length) {
    let chars = 0;
    for (const source of input.anchor.slice(0, ANCHOR_MAX_SOURCES)) {
      if (chars + source.text.length > ANCHOR_MAX_CHARS) break;
      chars += source.text.length;
      add({ ...source, via: "anchor" });
    }
  }

  // What the selection names, resolved to where the document states it.
  const linking = (strategy.linkedSources && !nested) || (strategy.nestedContext && nested);
  let linkBudget = LINK_BUDGET;
  if (linking) {
    const selectionRange =
      window?.range ?? (input.pageNumber !== null ? locateSelection(input.index, input.pageNumber, input.selection) : null);
    const linked = linkedSources({
      index: input.index,
      chunks: input.chunks,
      selection: input.selection,
      pageNumber: input.pageNumber,
      selectionRange,
      windowRange: window?.span,
      symbolPage: input.pageNumber ?? input.rootPage ?? input.index.pages.length,
      refsByPage: input.refsByPage,
      targets: input.targets,
      terms: input.terms,
      taken,
    }).filter(notAttached);
    linked.forEach(add);
    const linkedChars = linked.reduce((sum, source) => sum + source.text.length, 0);
    linkBudget = { maxSources: LINK_BUDGET.maxSources - linked.length, maxChars: LINK_BUDGET.maxChars - linkedChars };
  }
  if (area && input.targets && input.region && input.pageNumber !== null) {
    const { y1, y2, height } = input.region;
    regionCaptionSources({ chunks: input.chunks, targets: input.targets, pageNumber: input.pageNumber, top: y1 / height, bottom: y2 / height })
      .slice(0, 2)
      .filter(notAttached)
      .forEach(add);
  }

  // Chunks covering an attached passage are out of the running before
  // ranking, so the attached text's own chunk doesn't set the bar.
  for (const chunk of input.chunks) if (!notAttached(fromChunk(chunk))) taken.add(chunk.id);
  const used = chosen.reduce((sum, source) => sum + source.text.length, 0);

  if (!enriched) {
    const query = [input.selection, input.question ?? "", input.extraQuery ?? ""].join(" ").trim();
    if (query) {
      const relevant = selectRelevant(input.bm25, query, {
        typicalChars: Math.max(0, budget.typicalChars - used),
        ceilingChars: Math.max(0, budget.ceilingChars - used),
        exclude: taken,
      });
      relevant.map(({ chunk }) => tagged(fromChunk(chunk), "retrieval")).filter(notAttached).forEach(add);
    }
    return labelSources(chosen);
  }

  // What to search with: the selection — or for an area with no text, what
  // the region holds or sits beside — the follow-up, attached text, and the
  // names the glossary knows the selection's terms by.
  const selectionText =
    input.selection.trim() ||
    (window?.regionText ?? "") ||
    chosen.filter((source) => source.via === "xref").map((source) => source.text).join(" ").slice(0, AREA_QUERY_CHARS) ||
    (window?.chunks ?? []).map((chunk) => chunk.text).join(" ").slice(0, AREA_QUERY_CHARS);
  const page = input.pageNumber !== null ? input.index.pages[input.pageNumber - 1] : undefined;
  const sentence = page && window?.range ? page.text.slice(...sentenceAround(page.text, window.range[0], window.range[1])) : "";
  const shaped = strategy.rankingPriors ? diveQuery(selectionText, sentence, input.bm25) : { query: selectionText, phrases: [] };
  const aliases = linking
    ? (input.terms ?? [])
        .filter((term) => [term.term, ...term.aliases].some((name) => name && input.selection.toLowerCase().includes(name.toLowerCase())))
        .flatMap((term) => term.aliases)
    : [];
  const query = [shaped.query, input.question ?? "", input.extraQuery ?? "", ...aliases].join(" ").trim();

  // Where to look: near the selection (or, nested, the page the tree
  // started from), never in back matter.
  const at = input.pageNumber ?? input.rootPage ?? null;
  const priors = strategy.rankingPriors || (strategy.nestedContext && nested);
  const weights =
    priors && at !== null
      ? diveWeights(input.chunks, { pageNumber: at, sectionRange: sectionRangeAt(input.sections ?? [], at, input.index.pages.length) })
      : undefined;
  let excludePages: Set<number> | undefined;
  if (strategy.rankingPriors) {
    excludePages = new Set(cachedBackMatter(input.index, input.sections ?? []));
    if (at !== null) excludePages.delete(at);
  }

  if (query) {
    const relevant = selectRelevant(input.bm25, query, {
      typicalChars: RETRIEVAL_TYPICAL_CHARS,
      ceilingChars: Math.max(0, budget.ceilingChars - used),
      exclude: taken,
      weights,
      phrases: shaped.phrases,
      excludePages,
    });
    const retrieved = relevant.map(({ chunk }) => tagged(fromChunk(chunk), "retrieval")).filter(notAttached);
    retrieved.forEach(add);
    if (linking && input.refsByPage && linkBudget.maxSources > 0 && linkBudget.maxChars > 0) {
      secondHopSources({ chunks: input.chunks, retrieved, refsByPage: input.refsByPage, taken, budget: linkBudget })
        .filter(notAttached)
        .forEach(add);
    }
  }

  if (strategy.rankingPriors && input.sections?.length) {
    for (const source of chosen) {
      const path = sectionPathAt(input.sections, source.pageNumber).slice(-2);
      if (path.length) source.section = formatSectionPath(path);
    }
  }
  return labelSources(chosen);
}

interface LocalWindow {
  chunks: TextChunk[];
  range: [number, number]; // the selection (or the region's stand-in) on its page
  span: [number, number]; // the window's extent on the selection's page
  regionText?: string; // area dives: the text inside the region
}

// The local window (localWindow.ts) around a text selection or an area.
// Null when the selection can't be found on the page — the original
// neighbor logic then takes over, with its fallbacks.
function windowAround(input: DiveSourceInput, pageNumber: number, area: boolean): LocalWindow | null {
  const page = input.index.pages[pageNumber - 1];
  if (!page) return null;
  const pageChunks = input.chunks.filter((chunk) => chunk.pageNumber === pageNumber);
  const prevPageChunks = input.chunks.filter((chunk) => chunk.pageNumber === pageNumber - 1);
  let range: [number, number] | null = null;
  let regionText: string | undefined;
  if (area && input.region) {
    const inside = regionTextRange(page, input.region);
    if (inside) regionText = page.text.slice(inside[0], inside[1]);
    range = inside ?? regionAnchorRange(page, pageChunks, input.region);
  }
  range ??= locateSelection(input.index, pageNumber, input.selection);
  if (!range) return null;
  const theorems = findPageTargets(page).flatMap((target) => (target.kind === "theorem" && target.range ? [target.range[0]] : []));
  const chunks = localWindow({ pageChunks, prevPageChunks, range, statementStarts: statementStarts(page, theorems) });
  if (chunks.length === 0) return null;
  const onPage = chunks.filter((chunk) => chunk.pageNumber === pageNumber);
  const span: [number, number] = [onPage[0].start, onPage[onPage.length - 1].end];
  return { chunks, range, span, regionText };
}

const backMatterCache = new WeakMap<DocumentTextIndex, Set<number>>();

function cachedBackMatter(index: DocumentTextIndex, sections: Section[]): Set<number> {
  let pages = backMatterCache.get(index);
  if (!pages) {
    pages = backMatterPages(sections, index);
    backMatterCache.set(index, pages);
  }
  return pages;
}

// ---- Stable follow-up sources (the stableSources experiment) ----------------

export const FOLLOW_UP_BUDGET: ContextBudget = { typicalChars: 2000, ceilingChars: 20000 };

// The first answer's sources keep their labels and order; what a follow-up
// adds is numbered after them, in document order among itself — so "S3"
// means the same passage for the whole dive.
export function extendSources(base: SourceRef[], extra: SourceRef[]): SourceRef[] {
  const labeled = labelSources(extra).map((source, i) => ({ ...source, label: `S${base.length + i + 1}` }));
  return [...base, ...labeled];
}

// A follow-up with stable sources: the base set as it was, plus passages
// for the question itself — searched alone, or with the selection when the
// question leans on it ("why?", "explain that").
export function buildFollowUpSources(
  input: DiveSourceInput & { base: SourceRef[]; question: string; leansOnSelection: boolean },
  strategy: DiveContextStrategy = {},
): { sources: SourceRef[]; added: SourceRef[] } {
  const taken = new Set(input.base.map(sourceKey));
  const overlapsBase = (source: SourceRef) =>
    input.base.some((b) => b.pageNumber === source.pageNumber && b.start < source.end && source.start < b.end && !b.chunkId);
  const added: SourceRef[] = [];
  for (const source of input.attached ?? []) {
    if (taken.has(sourceKey(source))) continue;
    taken.add(sourceKey(source));
    added.push({ ...source, via: "attached" });
  }
  const notAttached = (source: SourceRef) =>
    !input.attached?.some((a) => a.pageNumber === source.pageNumber && a.end > a.start && a.start < source.end && source.start < a.end);
  for (const chunk of input.chunks) if (!notAttached(fromChunk(chunk))) taken.add(chunk.id);

  const query = [input.question, input.leansOnSelection ? input.selection : "", input.extraQuery ?? ""].join(" ").trim();
  const at = input.pageNumber ?? input.rootPage ?? null;
  const weights =
    strategy.rankingPriors && at !== null
      ? diveWeights(input.chunks, { pageNumber: at, sectionRange: sectionRangeAt(input.sections ?? [], at, input.index.pages.length) })
      : undefined;
  const excludePages = strategy.rankingPriors ? new Set(cachedBackMatter(input.index, input.sections ?? [])) : undefined;
  if (at !== null) excludePages?.delete(at);
  if (query) {
    selectRelevant(input.bm25, query, { ...FOLLOW_UP_BUDGET, exclude: taken, weights, excludePages })
      .map(({ chunk }) => ({ ...fromChunk(chunk), via: "retrieval" as const }))
      .filter((source) => notAttached(source) && !overlapsBase(source))
      .forEach((source) => added.push(source));
  }
  const sources = extendSources(input.base, added);
  return { sources, added: sources.slice(input.base.length) };
}
