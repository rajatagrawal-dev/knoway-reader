import type { PDFDocumentProxy } from "pdfjs-dist";
import { fetchGlossaryReference, streamGlossaryDefinition } from "../deepdive/api";
import { formatPageLabel } from "../pageLabels";
import { getTextIndex } from "../text/documentText";
import { buildGlossaryPrompt, buildGlossarySystem, referenceCandidates, type GlossaryExcerpt } from "./prompts";
import { parseGlossaryReply } from "./reply";
import type { GlossaryStore } from "./store";
import {
  cleanTerm,
  findDefiningMatch,
  findRelatedMatches,
  findTermMatches,
  matchId,
  matchPosition,
  mergeMatches,
  selectExcerpts,
  snippetAround,
  termKey,
  type TermMatch,
} from "./textIndex";
import type { GlossaryEntry, GlossaryRef } from "./types";

// A lookup finds the term's references locally (fast, exact — shown before
// the model has said anything), then sends the model only a handful of
// excerpts to write the definition from, keeping the prompt small and the
// definition grounded in this document. Meanwhile a dictionary and an
// encyclopedia are looked up on the web (server/reference.js); their
// entries go into the same, single model call, which says which of them
// (if any) matches the document's sense — that one is shown alongside.

const MAX_STORED_REFS = 200;
const MAX_EXCERPTS = 10;
const EXCERPT_RADIUS = 220; // chars either side of the term, per excerpt
const SNIPPET_RADIUS = 70; // chars either side, per reference in the panel
const MAX_ALIASES = 5;
const FALLBACK_PAGE_CHARS = 3000;
// How much longer the model call may wait for the web lookup once the
// excerpts are ready (the lookup runs during the document search too, so
// it gets that time on top). Uncached lookups take up to about 2s. A
// lookup that misses it just leaves the reference out.
const REFERENCE_WAIT_MS = 2000;

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms))]);
}

export interface GlossaryJobContext {
  pdfDocument: PDFDocumentProxy;
  fileName: string;
  pageLabels: string[] | null;
}

const runningJobs = new Map<string, AbortController>();

export function cancelGlossaryJob(entryId: string) {
  runningJobs.get(entryId)?.abort();
  runningJobs.delete(entryId);
}

// Adds a term selected on `pageNumber` and starts looking it up. A term
// already in the glossary isn't looked up again (unless its last lookup
// failed) — its existing entry's id is returned instead.
export function addGlossaryTerm(
  store: GlossaryStore,
  selection: string,
  pageNumber: number,
  context: GlossaryJobContext,
): string | null {
  const term = cleanTerm(selection);
  const key = termKey(term);
  if (!key) return null;

  const existing = store.findByKey(key);
  if (existing) {
    if (existing.status === "error") void runGlossaryJob(store, existing.id, context);
    return existing.id;
  }

  const entry: GlossaryEntry = {
    id: crypto.randomUUID(),
    term,
    key,
    pageNumber,
    status: "pending",
    definition: "",
    aliases: [],
    refs: [],
    refCount: 0,
    createdAt: new Date().toISOString(),
  };
  store.add(entry);
  void runGlossaryJob(store, entry.id, context);
  return entry.id;
}

function toRef(match: TermMatch): GlossaryRef | null {
  const position = matchPosition(match);
  if (!position) return null;
  return { id: matchId(match), pageNumber: match.page.pageNumber, position, ...snippetAround(match, SNIPPET_RADIUS) };
}

// References in document order, capped — but always including the one that
// defines the term, wherever it falls.
function toRefs(matches: TermMatch[], mustInclude?: TermMatch): GlossaryRef[] {
  const kept = matches.slice(0, MAX_STORED_REFS);
  if (mustInclude && !kept.includes(mustInclude)) {
    kept.push(mustInclude);
    kept.sort((a, b) => a.page.pageNumber - b.page.pageNumber || a.start - b.start);
  }
  return kept.map(toRef).filter((ref): ref is GlossaryRef => ref !== null);
}

function excerptText(match: TermMatch): string {
  const { before, match: term, after } = snippetAround(match, EXCERPT_RADIUS);
  return `${before}${term}${after}`;
}

export async function runGlossaryJob(store: GlossaryStore, entryId: string, context: GlossaryJobContext) {
  cancelGlossaryJob(entryId);
  const entry = store.get(entryId);
  if (!entry) return;
  const controller = new AbortController();
  runningJobs.set(entryId, controller);
  const { signal } = controller;

  store.update(
    entryId,
    {
      status: "pending",
      error: undefined,
      definition: "",
      source: undefined,
      origin: undefined,
      literal: undefined,
      reference: undefined,
      definedRefId: undefined,
    },
    { persist: false },
  );

  const referenceLookup = fetchGlossaryReference(entry.term, signal);

  try {
    const index = await getTextIndex(context.pdfDocument);
    if (signal.aborted) return;
    let matches = findTermMatches(index, entry.term);
    store.update(entryId, { refs: toRefs(matches), refCount: matches.length }, { persist: false });

    // Related forms ("entangled" for "entanglement") are candidates too:
    // the passage that defines a term often uses one of them.
    const candidates = mergeMatches(matches, findRelatedMatches(index, entry.term));
    const chosen = selectExcerpts(candidates, entry.pageNumber, MAX_EXCERPTS);
    const defining = findDefiningMatch(chosen);
    const excerpts: GlossaryExcerpt[] = chosen.map((match, i) => ({
      label: `S${i + 1}`,
      pageLabel: formatPageLabel(context.pageLabels, match.page.pageNumber),
      text: excerptText(match),
      isDefinition: match === defining,
    }));
    // The term wasn't found on the page it was selected from (a text-layer
    // quirk, or a selection spanning odd characters) — send that page as-is
    // so the model still sees the reader's own context.
    if (!chosen.some((match) => match.page.pageNumber === entry.pageNumber)) {
      const page = index.pages.find((p) => p.pageNumber === entry.pageNumber);
      if (page?.text) {
        excerpts.push({
          label: `S${excerpts.length + 1}`,
          pageLabel: formatPageLabel(context.pageLabels, entry.pageNumber),
          text: page.text.slice(0, FALLBACK_PAGE_CHARS),
          isDefinition: false,
        });
      }
    }

    const references = referenceCandidates(await settleWithin(referenceLookup, REFERENCE_WAIT_MS));
    if (signal.aborted) return;

    store.update(entryId, { status: "streaming" }, { persist: false });
    let raw = "";
    const full = await streamGlossaryDefinition({
      system: buildGlossarySystem(context.fileName),
      prompt: buildGlossaryPrompt(entry.term, excerpts, references),
      signal,
      onText: (chunk) => {
        raw += chunk;
        const parsed = parseGlossaryReply(raw);
        store.update(
          entryId,
          { definition: parsed.definition, source: parsed.source, origin: parsed.origin },
          { persist: false },
        );
      },
    });
    if (signal.aborted) return;

    const parsed = parseGlossaryReply(full || raw);
    if (!parsed.definition) throw new Error("The model returned no definition.");

    const aliases = parsed.aliases
      .filter((alias) => {
        const key = termKey(alias);
        return key && key !== entry.key;
      })
      .slice(0, MAX_ALIASES);
    for (const alias of aliases) matches = mergeMatches(matches, findTermMatches(index, alias));

    const definedMatch = parsed.definedIn ? chosen[Number(parsed.definedIn.slice(1)) - 1] : undefined;
    store.update(entryId, {
      status: "done",
      definition: parsed.definition,
      source: parsed.source,
      origin: parsed.origin,
      literal: parsed.literal,
      reference: references.find((candidate) => candidate.label === parsed.reference)?.reference,
      aliases,
      refs: toRefs(matches, definedMatch),
      refCount: matches.length,
      definedRefId: definedMatch ? matchId(definedMatch) : undefined,
    });
  } catch (error) {
    if (signal.aborted) return;
    store.update(entryId, {
      status: "error",
      error: error instanceof Error ? error.message : "Glossary lookup failed.",
    });
  } finally {
    if (runningJobs.get(entryId) === controller) runningJobs.delete(entryId);
  }
}
