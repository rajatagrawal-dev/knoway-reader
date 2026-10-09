import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex } from "../glossary/textIndex.ts";
import { chunkDocument, type TextChunk } from "../text/chunks.ts";
import { collectTargets, findPageRefs, type XrefRef } from "../xref/detect.ts";
import { buildDiveSources, buildFollowUpSources, extendSources } from "./context.ts";
import { linkedSources, refsInText, selectionSymbols } from "./links.ts";
import { localWindow, statementStarts } from "./localWindow.ts";
import { backMatterPages, diveQuery, diveWeights } from "./priors.ts";
import { renderSources } from "./prompt.ts";
import { buildBm25, selectRelevant } from "./retrieval.ts";
import type { SourceRef } from "./types.ts";

function chunk(id: string, pageNumber: number, text: string, start: number): TextChunk {
  return { id, pageNumber, start, end: start + text.length, text };
}

// A page of consecutive chunks, each `size` characters of `text`.
function pageChunks(pageNumber: number, texts: string[]): TextChunk[] {
  let at = 0;
  return texts.map((text, i) => {
    const c = chunk(`p${pageNumber}-${i}`, pageNumber, text, at);
    at += text.length + 1;
    return c;
  });
}

const words = (label: string, n: number) => `${label} ${"lorem ipsum ".repeat(Math.ceil(n / 12))}`.slice(0, n);

// ---- Local window -------------------------------------------------------------

test("the local window takes more before the selection than after", () => {
  const page = pageChunks(5, [words("a", 500), words("b", 500), words("c", 500), words("d", 500), words("e", 500), words("f", 500)]);
  const hit = page[3];
  const window = localWindow({ pageChunks: page, prevPageChunks: [], range: [hit.start + 10, hit.start + 40] });
  const ids = window.map((c) => c.id);
  assert.ok(ids.includes("p5-3"));
  const before = ids.filter((id) => Number(id.split("-")[1]) < 3).length;
  const after = ids.filter((id) => Number(id.split("-")[1]) > 3).length;
  assert.ok(before > after, `before ${before}, after ${after}`);
  assert.deepEqual(ids, [...ids].sort());
});

test("at the top of a page the window reaches back into the previous page", () => {
  const prev = pageChunks(4, [words("x", 500), words("y", 500)]);
  const page = pageChunks(5, [words("a", 500), words("b", 500)]);
  const window = localWindow({ pageChunks: page, prevPageChunks: prev, range: [5, 30] });
  assert.ok(window.some((c) => c.id === "p4-1"));
  // Not at the top: stays on its page.
  const lower = localWindow({ pageChunks: page, prevPageChunks: prev, range: [page[1].start + 5, page[1].start + 30] });
  assert.ok(lower.every((c) => c.pageNumber === 5));
});

test("an opening 'Therefore' pulls in the chunk before; a closing 'as follows:' the one after", () => {
  const page = pageChunks(2, [words("a", 400), words("b", 400), "Therefore the bound holds for every n and the claim follows directly from it.", words("d", 400), words("e", 400)]);
  const hit = page[2];
  const tight = { beforeChars: 0, afterChars: 0, capChars: 3500 };
  const back = localWindow({ pageChunks: page, prevPageChunks: [], range: [hit.start + 2, hit.start + 20], budget: tight });
  assert.deepEqual(back.map((c) => c.id), ["p2-1", "p2-2"]);

  const leading = pageChunks(3, [words("a", 400), "The derivation of the bound goes as follows:", words("c", 400)]);
  const forward = localWindow({ pageChunks: leading, prevPageChunks: [], range: [leading[1].start, leading[1].start + 10], budget: tight });
  assert.deepEqual(forward.map((c) => c.id), ["p3-1", "p3-2"]);
});

test("the cap holds even when every chunk asks for a neighbor", () => {
  const page = pageChunks(1, Array.from({ length: 8 }, () => `Therefore ${words("t", 590)} as follows:`));
  const hit = page[4];
  const window = localWindow({ pageChunks: page, prevPageChunks: [], range: [hit.start + 2, hit.start + 20] });
  const size = window.reduce((sum, c) => sum + c.text.length, 0);
  assert.ok(size <= 3500, `size ${size}`);
  assert.ok(window.some((c) => c.id === "p1-4"));
});

test("a selection inside a proof extends back to where the proof starts", () => {
  const page = pageChunks(7, [words("intro", 400), `Proof. ${words("setup", 400)}`, words("step", 600), words("step", 600), words("hit", 400)]);
  const proofStart = page[1].start;
  const hit = page[4];
  const window = localWindow({
    pageChunks: page,
    prevPageChunks: [],
    range: [hit.start + 5, hit.start + 30],
    statementStarts: [proofStart],
    budget: { beforeChars: 700, afterChars: 0, capChars: 3500 },
  });
  assert.equal(window[0].id, "p7-1");
});

// ---- Linking ------------------------------------------------------------------

function page(pageNumber: number, lines: string[]): PdfExtractedPage {
  return {
    pageNumber,
    width: 600,
    height: 800,
    textItems: lines.map((text, index) => ({
      text,
      index,
      pageNumber,
      rect: { left: 72, top: 100 + index * 15, width: text.length * 6, height: 12, pageNumber },
    })),
  };
}

const filler = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} discusses ${topic} in some detail for the reader.`);

function linkedBook() {
  const index = buildTextIndex([
    page(1, [...filler("history", 4), "Theorem 3.1. Every bounded sequence has a convergent subsequence.", ...filler("history", 4)]),
    page(2, [...filler("notation", 4), "We write ρ for the density matrix of the whole system.", ...filler("notation", 4)]),
    page(3, [
      ...filler("measurement", 6),
      "Therefore the sequence converges by Theorem 3.1 as shown in [1].",
      "The trace of ρ vanishes on this subspace.",
      ...filler("measurement", 6),
    ]),
    page(4, ["References", "[1] Smith, J. Analysis of bounded sequences. 1990.", "[2] Doe, A. Unrelated work on graphs. 2001."]),
  ]);
  const chunks = chunkDocument(index);
  const targets = collectTargets(index.pages, []);
  const refsByPage = new Map<number, XrefRef[]>();
  for (const p of index.pages) refsByPage.set(p.pageNumber, findPageRefs(p, targets));
  return { index, chunks, bm25: buildBm25(chunks), targets, refsByPage };
}

function rangeOf(index: ReturnType<typeof buildTextIndex>, pageNumber: number, text: string): [number, number] {
  const at = index.pages[pageNumber - 1].text.indexOf(text);
  assert.ok(at !== -1, `"${text}" on page ${pageNumber}`);
  return [at, at + text.length];
}

test("a theorem the selection names comes along, labeled with its name", () => {
  const { index, chunks, targets, refsByPage } = linkedBook();
  const selection = "the sequence converges by Theorem 3.1";
  const linked = linkedSources({
    index,
    chunks,
    selection,
    pageNumber: 3,
    selectionRange: rangeOf(index, 3, selection),
    symbolPage: 3,
    refsByPage,
    targets,
    taken: new Set(),
  });
  const theorem = linked.find((s) => s.is === "Theorem 3.1");
  assert.ok(theorem && theorem.pageNumber === 1 && theorem.text.includes("Every bounded sequence"));
  assert.equal(theorem.via, "xref");
  // The citation in the same sentence brings its bibliography entry.
  const citation = linked.find((s) => s.is === "[1]");
  assert.ok(citation && citation.text.includes("Smith") && !citation.text.includes("Doe"));
});

test("a linked passage already chosen adds nothing", () => {
  const { index, chunks, targets, refsByPage } = linkedBook();
  const selection = "the sequence converges by Theorem 3.1";
  const theoremChunk = chunks.find((c) => c.pageNumber === 1 && c.text.includes("Theorem 3.1"))!;
  const linked = linkedSources({
    index,
    chunks,
    selection,
    pageNumber: 3,
    selectionRange: rangeOf(index, 3, selection),
    symbolPage: 3,
    refsByPage,
    targets,
    taken: new Set([theoremChunk.id]),
  });
  assert.ok(!linked.some((s) => s.chunkId === theoremChunk.id));
});

test("a symbol defined on an earlier page brings its definition; one never defined before brings nothing", () => {
  const { index, chunks } = linkedBook();
  assert.deepEqual(selectionSymbols(index, "The trace of ρ vanishes"), ["ρ"]);
  const linked = linkedSources({
    index,
    chunks,
    selection: "The trace of ρ vanishes",
    pageNumber: 3,
    selectionRange: rangeOf(index, 3, "The trace of ρ vanishes"),
    symbolPage: 3,
    taken: new Set(),
  });
  const definition = linked.find((s) => s.via === "symbol");
  assert.ok(definition && definition.pageNumber === 2 && definition.is === "definition of ρ");
  // Read as of page 1, before it's defined: nothing.
  const early = linkedSources({ index, chunks, selection: "ρ", pageNumber: null, selectionRange: null, symbolPage: 1, taken: new Set() });
  assert.equal(early.length, 0);
});

test("a glossary term the selection uses brings the passage defining it", () => {
  const { index, chunks } = linkedBook();
  const start = index.pages[1].text.indexOf("We write");
  const linked = linkedSources({
    index,
    chunks,
    selection: "the density operator of the system",
    pageNumber: 3,
    selectionRange: null,
    symbolPage: 3,
    terms: [{ term: "density matrix", aliases: ["density operator"], definedAt: { pageNumber: 2, start } }],
    taken: new Set(),
  });
  assert.ok(linked.some((s) => s.via === "term" && s.pageNumber === 2 && s.is === 'definition of "density matrix"'));
});

test("the link budget caps how many passages come along", () => {
  const { index, chunks, targets, refsByPage } = linkedBook();
  const selection = "the sequence converges by Theorem 3.1 as shown in [1]";
  const linked = linkedSources({
    index,
    chunks,
    selection,
    pageNumber: 3,
    selectionRange: rangeOf(index, 3, "the sequence converges by Theorem 3.1 as shown in [1]"),
    symbolPage: 3,
    refsByPage,
    targets,
    taken: new Set(),
    budget: { maxSources: 1, maxChars: 10_000 },
  });
  assert.equal(linked.length, 1);
});

test("references in answer text resolve against the document's targets", () => {
  const { targets } = linkedBook();
  const refs = refsInText("This is exactly what Theorem 3.1 guarantees.", targets);
  assert.equal(refs[0]?.targets[0]?.key, "theorem:3.1");
});

// ---- Strategies through buildDiveSources ----------------------------------------

test("with no strategy, dive sources are chosen exactly as before", () => {
  const { index, chunks, bm25, targets, refsByPage } = linkedBook();
  const input = { index, chunks, bm25, selection: "the sequence converges by Theorem 3.1", pageNumber: 3 };
  const plain = buildDiveSources(input);
  // The extra inputs are ignored until a strategy asks for them.
  const withInputs = buildDiveSources({ ...input, targets, refsByPage }, undefined, {});
  assert.deepEqual(withInputs, plain);
  assert.ok(!plain.some((s) => s.is));
});

test("linkedSources through buildDiveSources: the named theorem is sent and labeled for the model", () => {
  const { index, chunks, bm25, targets, refsByPage } = linkedBook();
  const sources = buildDiveSources(
    { index, chunks, bm25, selection: "the sequence converges by Theorem 3.1", pageNumber: 3, targets, refsByPage },
    undefined,
    { linkedSources: true },
  );
  const theorem = sources.find((s) => s.is === "Theorem 3.1");
  assert.ok(theorem);
  assert.match(renderSources(sources, String), /is="Theorem 3\.1"/);
  assert.deepEqual(
    sources.map((s) => s.label),
    sources.map((_, i) => `S${i + 1}`),
  );
});

test("a nested dive with nestedContext resolves what its selection names and keeps the root passage", () => {
  const { index, chunks, bm25, targets, refsByPage } = linkedBook();
  const anchor: SourceRef[] = [{ label: "S1", pageNumber: 3, start: 0, end: 20, text: "Therefore the sequence converges", chunkId: "p3-1" }];
  const sources = buildDiveSources(
    { index, chunks, bm25, selection: "what Theorem 3.1 says", pageNumber: null, targets, refsByPage, anchor, rootPage: 3 },
    undefined,
    { nestedContext: true },
  );
  assert.ok(sources.some((s) => s.via === "anchor" && s.chunkId === "p3-1"));
  assert.ok(sources.some((s) => s.is === "Theorem 3.1"));
  // Off: neither.
  const plain = buildDiveSources({ index, chunks, bm25, selection: "what Theorem 3.1 says", pageNumber: null, targets, refsByPage, anchor, rootPage: 3 });
  assert.ok(!plain.some((s) => s.via === "anchor" || s.is));
});

// ---- Ranking signals -------------------------------------------------------------

test("back matter: outline sections by title, and pages that are mostly numbers", () => {
  const index = buildTextIndex([
    page(1, filler("intro", 5)),
    page(2, ["Bell states, 12, 45, 46", "entanglement, 3, 7, 9, 88", ...Array.from({ length: 12 }, (_, i) => `term ${i}, ${i + 1}, ${i + 20}, ${i + 40}`)]),
    page(3, filler("refs", 5)),
  ]);
  const pages = backMatterPages([{ title: "Intro", depth: 0, pageNumber: 1 }, { title: "Bibliography", depth: 0, pageNumber: 3 }], index);
  assert.ok(pages.has(2) && pages.has(3) && !pages.has(1));
});

test("section weights let a same-section chunk beat an equal one far away; the floor stays on raw scores", () => {
  const corpus = [
    chunk("near", 10, "Bell states are entangled pairs.", 0),
    chunk("far", 200, "Bell states are entangled pairs.", 0),
    chunk("weak", 11, "Pairs of socks.", 0),
  ];
  const bm25 = buildBm25(corpus);
  const weights = diveWeights(corpus, { pageNumber: 12, sectionRange: [9, 14] });
  const ranked = selectRelevant(bm25, "Bell states entangled", { typicalChars: 1000, ceilingChars: 1000, weights });
  assert.equal(ranked[0].chunk.id, "near");
  const huge = selectRelevant(bm25, "Bell states entangled socks", { typicalChars: 1000, ceilingChars: 1000, weights: [1, 1, 100], minFraction: 0.5 });
  assert.ok(!huge.some((r) => r.chunk.id === "weak"));
});

test("a phrase match outranks the same words scattered apart", () => {
  const corpus = [chunk("scattered", 1, "The state was mixed; a density of matrix entries.", 0), chunk("phrase", 2, "The density matrix of the state.", 0)];
  const bm25 = buildBm25(corpus);
  const { query, phrases } = diveQuery("density matrix", "", bm25);
  assert.deepEqual(phrases, ["density matrix"]);
  const ranked = selectRelevant(bm25, query, { typicalChars: 1000, ceilingChars: 1000, phrases, relativeCutoff: 0 });
  assert.equal(ranked[0].chunk.id, "phrase");
});

test("a short selection borrows its sentence's words; a long one keeps its rarest", () => {
  const bm25 = buildBm25([chunk("a", 1, "common common common rare", 0), chunk("b", 2, "common text", 0)]);
  assert.match(diveQuery("ρ", "The trace of rho vanishes here", bm25).query, /trace/);
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
  assert.equal(diveQuery(long, "", bm25).query.split(" ").length, 12);
});

// ---- Stable follow-up sources ----------------------------------------------------

test("extendSources keeps the base labels and numbers additions after them", () => {
  const base: SourceRef[] = [
    { label: "S1", pageNumber: 1, start: 0, end: 5, text: "alpha" },
    { label: "S2", pageNumber: 4, start: 0, end: 5, text: "delta" },
  ];
  const extra: SourceRef[] = [
    { label: "", pageNumber: 9, start: 0, end: 5, text: "omega" },
    { label: "", pageNumber: 2, start: 0, end: 4, text: "beta" },
  ];
  const all = extendSources(base, extra);
  assert.deepEqual(all.map((s) => `${s.label}:${s.text}`), ["S1:alpha", "S2:delta", "S3:beta", "S4:omega"]);
});

test("a follow-up on a new topic adds passages the base set doesn't have, after it", () => {
  const { index, chunks, bm25 } = linkedBook();
  const base = buildDiveSources({ index, chunks, bm25, selection: "The trace of ρ vanishes", pageNumber: 3 });
  const { sources, added } = buildFollowUpSources({
    index,
    chunks,
    bm25,
    selection: "The trace of ρ vanishes",
    pageNumber: 3,
    base,
    question: "What does Theorem 3.1 say about a bounded sequence?",
    leansOnSelection: false,
  });
  assert.deepEqual(sources.slice(0, base.length), base);
  assert.ok(added.length > 0);
  assert.ok(added.every((s, i) => s.label === `S${base.length + i + 1}`));
  assert.ok(added.some((s) => s.pageNumber === 1));
});

test("statementStarts finds 'Proof.' openings alongside theorem labels", () => {
  const index = buildTextIndex([page(1, ["Some text before it.", "Proof. We argue by induction.", "Done."])]);
  const starts = statementStarts(index.pages[0], [3]);
  assert.equal(starts[0], 3);
  assert.equal(index.pages[0].text.slice(starts[1], starts[1] + 6), "Proof.");
});
