import type { PDFDocumentProxy } from "pdfjs-dist";
import { streamGlossaryDefinition } from "../deepdive/api";
import type { GlossaryJobContext } from "../glossary/job";
import type { GlossaryStore } from "../glossary/store";
import { matchId, matchPosition, snippetAround, type TermMatch } from "../glossary/textIndex";
import type { GlossaryEntry, GlossaryRef } from "../glossary/types";
import { formatPageLabel } from "../pageLabels";
import { getSections, getTextIndex } from "../text/documentText";
import { buildNotationPrompt, buildNotationSystem, parseNotationReply, type NotationExcerpt } from "./prompts";
import {
  findSymbolSites,
  laterDefinitionPages,
  meaningAt,
  mergeMeaning,
  needsLookup,
  normalizeSymbol,
  parseSymbolList,
  pickSites,
  symbolKey,
  type NotationMeaning,
  type SymbolListEntry,
} from "./symbols";

// Looking up a symbol, in order of cost: the document's own list of symbols
// (no model), a meaning already known for this stretch of the document (no
// model), else a short model call over the few passages likeliest to define
// it — preferring the definition in effect at the page being read.

const EXCERPT_RADIUS = 220;
const SNIPPET_RADIUS = 70;
const MAX_REFS = 200;
const FALLBACK_PAGE_CHARS = 1500;

export interface NotationRequest {
  selection: string; // the symbol's text ("" for an area selection whose text is unreadable)
  pageNumber: number;
  image?: { mediaType: string; data: string }; // an area-selected symbol, as printed
}

const lists = new WeakMap<PDFDocumentProxy, Promise<SymbolListEntry[]>>();

export function getSymbolList(pdf: PDFDocumentProxy): Promise<SymbolListEntry[]> {
  let list = lists.get(pdf);
  if (!list) {
    list = Promise.all([getTextIndex(pdf), getSections(pdf).catch(() => [])]).then(([index, sections]) =>
      parseSymbolList(index, sections),
    );
    list.catch(() => lists.delete(pdf));
    lists.set(pdf, list);
  }
  return list;
}

function toRef(match: TermMatch): GlossaryRef | null {
  const position = matchPosition(match);
  if (!position) return null;
  return { id: matchId(match), pageNumber: match.page.pageNumber, position, ...snippetAround(match, SNIPPET_RADIUS) };
}

// A key for a symbol known only by its picture (an area selection whose
// text the PDF garbles): the same crop looks up the same entry.
function imageKey(image: { data: string }): string {
  let hash = 0;
  for (let i = 0; i < image.data.length; i += 7) hash = (hash * 31 + image.data.charCodeAt(i)) | 0;
  return `sym:img:${(hash >>> 0).toString(36)}`;
}

const running = new Map<string, AbortController>();

export function cancelNotationJob(entryId: string) {
  running.get(entryId)?.abort();
  running.delete(entryId);
}

// Adds (or finds) the symbol's entry and looks it up for `pageNumber`. An
// entry already known is looked up again only if the meaning in effect
// there isn't known yet (see runNotationJob).
export function addNotationEntry(store: GlossaryStore, request: NotationRequest, context: GlossaryJobContext): string | null {
  const symbol = request.selection.replace(/\s+/g, " ").trim();
  const key = normalizeSymbol(symbol) ? symbolKey(symbol) : request.image ? imageKey(request.image) : "";
  if (!key) return null;
  const existing = store.findByKey(key);
  if (existing) {
    void runNotationJob(store, existing.id, context, request.pageNumber);
    return existing.id;
  }
  const entry: GlossaryEntry = {
    id: crypto.randomUUID(),
    kind: "symbol",
    term: symbol,
    key,
    pageNumber: request.pageNumber,
    status: "pending",
    definition: "",
    aliases: [],
    refs: [],
    refCount: 0,
    createdAt: new Date().toISOString(),
    ...(request.image ? { image: request.image } : {}),
  };
  store.add(entry);
  void runNotationJob(store, entry.id, context, request.pageNumber);
  return entry.id;
}

// Shows the meaning in effect on `page` from what's already known.
function applyMeaning(store: GlossaryStore, entry: GlossaryEntry, meanings: NotationMeaning[], page: number, extra: Partial<GlossaryEntry> = {}) {
  const known = meaningAt(meanings, page)!;
  store.update(entry.id, {
    status: "done",
    error: undefined,
    pageNumber: page,
    meanings,
    definition: known.meaning.definition,
    source: known.meaning.source,
    definedRefId: known.meaning.refId,
    ...extra,
  });
}

export async function runNotationJob(store: GlossaryStore, entryId: string, context: GlossaryJobContext, page: number) {
  cancelNotationJob(entryId);
  const entry = store.get(entryId);
  if (!entry) return;
  const controller = new AbortController();
  running.set(entryId, controller);
  const { signal } = controller;

  try {
    const index = await getTextIndex(context.pdfDocument);
    if (signal.aborted) return;
    const symbol = entry.term;
    const sites = normalizeSymbol(symbol) ? findSymbolSites(index, symbol) : [];
    const refs = sites.slice(0, MAX_REFS).map(toRef).filter((ref): ref is GlossaryRef => ref !== null);
    const later = laterDefinitionPages(sites, page);

    // 1. The document's own list of symbols.
    const listed = (await getSymbolList(context.pdfDocument).catch(() => [])).find((item) => item.key === entry.key);
    if (listed && signal.aborted === false) {
      const listPage = index.pages[listed.pageNumber - 1];
      const listRef = listPage ? toRef({ page: listPage, start: listed.start, end: listed.start + listed.symbol.length }) : null;
      const meanings = mergeMeaning(entry.meanings, {
        fromPage: 1,
        definition: listed.meaning,
        source: "defined",
        refId: listRef?.id,
      });
      applyMeaning(store, entry, meanings, page, {
        refs: listRef ? [listRef, ...refs] : refs,
        refCount: sites.length,
        laterDefinitionPages: [],
      });
      return;
    }

    // 2. Already known where it's being read.
    if (entry.meanings?.length && !needsLookup(entry.meanings, sites, page)) {
      applyMeaning(store, entry, entry.meanings, page, { laterDefinitionPages: later });
      return;
    }

    // 3. Ask, over the likeliest defining passages.
    store.update(entryId, { status: "pending", error: undefined, pageNumber: page, definition: "", refs, refCount: sites.length }, { persist: false });
    const chosen = pickSites(sites, page);
    const pageLabel = (n: number) => formatPageLabel(context.pageLabels, n);
    const excerpts: NotationExcerpt[] = chosen.map((site, i) => {
      const { before, match, after } = snippetAround(site, EXCERPT_RADIUS);
      return { label: `S${i + 1}`, pageLabel: pageLabel(site.page.pageNumber), text: `${before}${match}${after}`, isReadingPage: site.page.pageNumber === page };
    });
    if (!chosen.some((site) => site.page.pageNumber === page)) {
      const reading = index.pages[page - 1];
      if (reading?.text) {
        excerpts.push({ label: `S${excerpts.length + 1}`, pageLabel: pageLabel(page), text: reading.text.slice(0, FALLBACK_PAGE_CHARS), isReadingPage: true });
      }
    }

    store.update(entryId, { status: "streaming" }, { persist: false });
    let raw = "";
    const full = await streamGlossaryDefinition({
      system: buildNotationSystem(context.fileName),
      prompt: buildNotationPrompt(symbol, pageLabel(page), excerpts),
      images: entry.image ? [entry.image] : undefined,
      signal,
      onText: (chunk) => {
        raw += chunk;
        const parsed = parseNotationReply(raw);
        store.update(entryId, { definition: parsed.definition, source: parsed.source, symbolLatex: parsed.symbolLatex }, { persist: false });
      },
    });
    if (signal.aborted) return;
    const parsed = parseNotationReply(full || raw);
    if (!parsed.definition) throw new Error("The model returned no meaning.");

    // Only an excerpt that's an occurrence of the symbol can be where it's
    // defined (the fallback page text isn't one).
    const definedSite = parsed.definedIn ? chosen[Number(parsed.definedIn.slice(1)) - 1] : undefined;
    const source = parsed.source === "defined" && !definedSite ? "inferred" : (parsed.source ?? "inferred");
    const meaning: NotationMeaning = {
      fromPage: definedSite && source !== "general" ? definedSite.page.pageNumber : page,
      definition: parsed.definition,
      source,
      refId: definedSite ? matchId(definedSite) : undefined,
    };
    const definedRef = definedSite ? toRef(definedSite) : null;
    applyMeaning(store, store.get(entryId) ?? entry, mergeMeaning(entry.meanings, meaning), page, {
      symbolLatex: parsed.symbolLatex ?? entry.symbolLatex,
      refs: definedRef && !refs.some((r) => r.id === definedRef.id) ? [definedRef, ...refs] : refs,
      refCount: sites.length,
      laterDefinitionPages: later.filter((p) => p > meaning.fromPage),
      // An image-only symbol takes its name from the model's reading of it.
      ...(!entry.term && parsed.symbolLatex ? { term: parsed.symbolLatex.replace(/^\$|\$$/g, "") } : {}),
    });
  } catch (error) {
    if (signal.aborted) return;
    store.update(entryId, { status: "error", error: error instanceof Error ? error.message : "Notation lookup failed." });
  } finally {
    if (running.get(entryId) === controller) running.delete(entryId);
  }
}
