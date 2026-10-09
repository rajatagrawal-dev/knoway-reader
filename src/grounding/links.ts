import type { DocumentTextIndex, IndexedPage } from "../glossary/textIndex.ts";
import { DEFINING_SCORE, findSymbolSites, isSymbolCandidate, normalizeSymbol, pickSites } from "../notation/symbols.ts";
import type { TextChunk } from "../text/chunks.ts";
import { findPageRefs, sentenceAround, type XrefRef, type XrefTarget, type XrefTargets } from "../xref/detect.ts";
import type { SourceRef, SourceVia } from "./types.ts";

// What a dive's selection names — "by Theorem 3.1", "Eq. (4)", "[12]", a
// symbol defined thirty pages back, a glossary term — resolved to the
// passage that states or defines it, so the model can explain the
// selection from the document rather than guess. One hop only, capped: a
// few linked passages, never a crawl. Pure; used only by the linkedSources,
// areaContext and nestedContext dive experiments (context.ts).

export interface LinkBudget {
  maxSources: number;
  maxChars: number;
}

export const LINK_BUDGET: LinkBudget = { maxSources: 5, maxChars: 2500 };
// References found inside retrieved passages (the second hop) share what's
// left of the budget, and never take more than this many.
export const SECOND_HOP_MAX = 2;

// A glossary entry, reduced to what linking needs: where the document
// defines it, located in the page text by the caller.
export interface LinkTerm {
  term: string;
  aliases: string[];
  definedAt?: { pageNumber: number; start: number };
}

function chunkAt(chunks: TextChunk[], pageNumber: number, offset: number): TextChunk | null {
  return chunks.find((chunk) => chunk.pageNumber === pageNumber && chunk.start <= offset && offset < chunk.end) ?? null;
}

function fromChunk(chunk: TextChunk, via: SourceVia, is: string): SourceRef {
  return { label: "", pageNumber: chunk.pageNumber, start: chunk.start, end: chunk.end, text: chunk.text, chunkId: chunk.id, via, is };
}

// The passage(s) a cross-reference target stands for: a bibliography
// entry's own text for a citation; otherwise the chunk holding its label —
// plus the next one for a theorem whose label sits late in its chunk, so
// the statement isn't cut off.
function resolveTarget(target: XrefTarget, chunks: TextChunk[]): SourceRef[] {
  if (target.kind === "citation") {
    if (!target.entryText || !target.range) return [];
    const start = target.range[0];
    return [
      { label: "", pageNumber: target.pageNumber, start, end: start + target.entryText.length, text: target.entryText, via: "xref", is: target.name },
    ];
  }
  if (!target.range) return [];
  const chunk = chunkAt(chunks, target.pageNumber, target.range[0]);
  if (!chunk) return [];
  const found = [fromChunk(chunk, "xref", target.name)];
  if (target.kind === "theorem" && target.range[0] - chunk.start > (chunk.end - chunk.start) / 2) {
    const next = chunks[chunks.indexOf(chunk) + 1];
    if (next && next.pageNumber === chunk.pageNumber) found.push(fromChunk(next, "xref", `${target.name} (cont.)`));
  }
  return found;
}

// References in a piece of text that isn't a page — a nested dive's
// selection, taken from an answer: the same detector, run over the text as
// if it were a page with no layout.
export function refsInText(text: string, targets: XrefTargets): XrefRef[] {
  const page: IndexedPage = {
    pageNumber: 0,
    width: 0,
    height: 0,
    items: [],
    text,
    lower: text.toLowerCase(),
    charItem: [],
    charOffset: [],
  };
  return findPageRefs(page, targets);
}

// Refs on the selection's page, most telling first: inside the selection,
// then in its sentence, then elsewhere in the local window.
export function prioritizedPageRefs(
  page: IndexedPage,
  refs: XrefRef[],
  selection: [number, number],
  window?: [number, number],
): XrefRef[] {
  const [start, end] = selection;
  const sentence = sentenceAround(page.text, start, end);
  const overlaps = (ref: XrefRef, [s, e]: [number, number]) => ref.start < e && s < ref.end;
  const tiers = [
    refs.filter((ref) => overlaps(ref, selection)),
    refs.filter((ref) => overlaps(ref, sentence)),
    window ? refs.filter((ref) => overlaps(ref, window)) : [],
  ];
  return [...new Set(tiers.flat())];
}

const SKIP_SYMBOLS = new Set(["a", "A", "I"]);

// Symbols in the selection worth looking up: tokens that read as notation,
// rarest in the document first (a common letter says less), at most three.
export function selectionSymbols(index: DocumentTextIndex, selection: string, max = 3): string[] {
  const tokens = selection
    .split(/[\s,;:()[\]{}=+<>|/]+/)
    .map((token) => token.trim())
    .filter((token) => token && !/^\d+$/.test(token) && !SKIP_SYMBOLS.has(token) && isSymbolCandidate(token));
  const unique = [...new Map(tokens.map((token) => [normalizeSymbol(token), token])).values()].slice(0, 6);
  return unique
    .map((symbol) => ({ symbol, count: findSymbolSites(index, symbol).length }))
    .filter(({ count }) => count > 0)
    .sort((a, b) => a.count - b.count)
    .slice(0, max)
    .map(({ symbol }) => symbol);
}

function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return escaped ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text) : false;
}

export interface LinkParams {
  index: DocumentTextIndex;
  chunks: TextChunk[];
  selection: string;
  // Root dives: the selection's page and where it is on it, and the local
  // window's span there. Nested dives have neither.
  pageNumber: number | null;
  selectionRange: [number, number] | null;
  windowRange?: [number, number];
  // The page to read a symbol's meaning at: the selection's, or for a
  // nested dive the page its tree started from.
  symbolPage: number;
  refsByPage?: Map<number, XrefRef[]>;
  targets?: XrefTargets;
  terms?: LinkTerm[];
  taken: ReadonlySet<string>; // sources already chosen (chunk ids, or "page:start")
  budget?: LinkBudget;
}

export const sourceKey = (source: Pick<SourceRef, "chunkId" | "pageNumber" | "start">) =>
  source.chunkId ?? `${source.pageNumber}:${source.start}`;

// Adds candidates in order until the budget runs out, skipping what's
// already chosen.
function collect(candidates: SourceRef[][], taken: ReadonlySet<string>, budget: LinkBudget): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set(taken);
  let chars = 0;
  for (const group of candidates) {
    const fresh = group.filter((source) => !seen.has(sourceKey(source)));
    if (fresh.length === 0) continue;
    const groupChars = fresh.reduce((sum, source) => sum + source.text.length, 0);
    if (out.length + fresh.length > budget.maxSources || chars + groupChars > budget.maxChars) continue;
    fresh.forEach((source) => {
      seen.add(sourceKey(source));
      out.push(source);
    });
    chars += groupChars;
  }
  return out;
}

export function linkedSources(params: LinkParams): SourceRef[] {
  const { index, chunks, selection, pageNumber, selectionRange, refsByPage, targets, terms = [] } = params;
  const candidates: SourceRef[][] = [];

  // Cross-references.
  let refs: XrefRef[] = [];
  const page = pageNumber !== null ? index.pages[pageNumber - 1] : undefined;
  if (page && selectionRange && refsByPage) {
    refs = prioritizedPageRefs(page, refsByPage.get(page.pageNumber) ?? [], selectionRange, params.windowRange);
  } else if (pageNumber === null && targets) {
    refs = refsInText(selection, targets);
  }
  for (const ref of refs) for (const target of ref.targets) candidates.push(resolveTarget(target, chunks));

  // Symbols: the strongest defining site at or before the page being read.
  for (const symbol of selectionSymbols(index, selection)) {
    const [site] = pickSites(findSymbolSites(index, symbol), params.symbolPage, 1, 0);
    if (!site || site.score < DEFINING_SCORE || site.page.pageNumber > params.symbolPage) continue;
    const chunk = chunkAt(chunks, site.page.pageNumber, site.start);
    if (chunk) candidates.push([fromChunk(chunk, "symbol", `definition of ${symbol}`)]);
  }

  // Glossary terms the selection uses, where the document defines them.
  for (const term of terms) {
    if (!term.definedAt || ![term.term, ...term.aliases].some((name) => mentions(selection, name))) continue;
    const chunk = chunkAt(chunks, term.definedAt.pageNumber, term.definedAt.start);
    if (chunk) candidates.push([fromChunk(chunk, "term", `definition of "${term.term}"`)]);
  }

  return collect(candidates, params.taken, params.budget ?? LINK_BUDGET);
}

// The second hop: references inside passages retrieval chose, resolved the
// same way, within what's left of the link budget.
export function secondHopSources(params: {
  chunks: TextChunk[];
  retrieved: SourceRef[];
  refsByPage: Map<number, XrefRef[]>;
  taken: ReadonlySet<string>;
  budget: LinkBudget;
}): SourceRef[] {
  const candidates: SourceRef[][] = [];
  for (const source of params.retrieved) {
    const refs = (params.refsByPage.get(source.pageNumber) ?? []).filter((ref) => ref.start < source.end && source.start < ref.end);
    for (const ref of refs) for (const target of ref.targets) candidates.push(resolveTarget(target, params.chunks));
  }
  const budget = { maxSources: Math.min(SECOND_HOP_MAX, params.budget.maxSources), maxChars: params.budget.maxChars };
  return collect(candidates, params.taken, budget);
}

// Area dives: the figures and tables whose extent overlaps the region (or
// sits just under it, where a caption goes), as their caption passage.
export function regionCaptionSources(params: {
  chunks: TextChunk[];
  targets: XrefTargets;
  pageNumber: number;
  top: number; // the region, as fractions of the page height
  bottom: number;
}): SourceRef[] {
  const found: SourceRef[] = [];
  for (const target of params.targets.byKey.values()) {
    if (target.pageNumber !== params.pageNumber || (target.kind !== "figure" && target.kind !== "table")) continue;
    if (target.top > params.bottom + 0.08 || target.bottom < params.top) continue;
    found.push(...resolveTarget(target, params.chunks));
  }
  return found;
}
