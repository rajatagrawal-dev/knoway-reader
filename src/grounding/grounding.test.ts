import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex } from "../glossary/textIndex.ts";
import { chunkDocument, type TextChunk } from "../text/chunks.ts";
import {
  answerGrounding,
  citedSources,
  decodeChipTarget,
  localizeClaim,
  markersToPages,
  parseAnswer,
  toChipMarkdown,
  trimPartialMarker,
} from "./citations.ts";
import {
  addAttachment,
  attachmentInstructions,
  attachmentSources,
  makeAttachment,
  makeRegionAttachment,
  attachmentImages,
  regionTextRange,
  ATTACHMENT_MAX_CHARS,
  MAX_ATTACHMENTS,
} from "./attachments.ts";
import { inferScope, type ScopeContext } from "./scope.ts";
import { buildAskSystem, selectAskSources, wantsWholeScope, type AskScope } from "./ask.ts";
import { buildDiveSources, labelSources } from "./context.ts";
import { MATH_RULES, renderSources } from "./prompt.ts";
import { buildBm25, scoreChunks, selectRelevant, tokenize } from "./retrieval.ts";
import type { SourceRef } from "./types.ts";

const pageLabel = (n: number) => String(n);

function chunk(id: string, pageNumber: number, text: string, start = 0): TextChunk {
  return { id, pageNumber, start, end: start + text.length, text };
}

function source(label: string, pageNumber: number, text: string, start = 0): SourceRef {
  return { label, pageNumber, start, end: start + text.length, text };
}

// ---- Retrieval -------------------------------------------------------------

test("tokenize drops stopwords and folds plurals", () => {
  assert.deepEqual(tokenize("The Bell states are entangled, and the qubits' phases vary."), [
    "bell",
    "state",
    "entangled",
    "qubit",
    "phase",
    "vary",
  ]);
});

const CORPUS = [
  chunk("a", 1, "A Bell state is a maximally entangled state of two qubits."),
  chunk("b", 2, "The Hadamard gate puts a qubit into superposition."),
  chunk("c", 3, "Bell states are prepared with a Hadamard gate followed by a CNOT."),
  chunk("d", 4, "Classical bits hold one value at a time."),
  chunk("e", 5, "Teleportation consumes one Bell state shared between two parties."),
];

test("BM25 ranks chunks sharing rarer query terms higher", () => {
  const scores = scoreChunks(buildBm25(CORPUS), "Bell state entangled");
  const order = CORPUS.map((c, i) => [c.id, scores[i]] as const).sort((x, y) => y[1] - x[1]);
  assert.equal(order[0][0], "a");
  assert.equal(scores[3], 0);
});

test("selectRelevant stops where relevance drops off, not at a count", () => {
  const index = buildBm25(CORPUS);
  const ids = (query: string) =>
    selectRelevant(index, query, { typicalChars: 10_000, ceilingChars: 10_000 }).map((s) => s.chunk.id);
  const bell = ids("Bell state entangled");
  assert.equal(bell[0], "a");
  assert.ok(bell.includes("c"));
  assert.ok(!bell.includes("b") && !bell.includes("d"));
  assert.deepEqual(ids("classical bits"), ["d"]);
  assert.deepEqual(ids("photosynthesis"), []);
});

test("selectRelevant fills the typical size, then only strongly relevant chunks up to the ceiling", () => {
  const index = buildBm25(CORPUS);
  const len = CORPUS[0].text.length;
  const chosen = selectRelevant(index, "Bell state", { typicalChars: len, ceilingChars: 10_000 });
  // One fits the typical size; the rest must clear the strong cutoff.
  assert.ok(chosen.length >= 1);
  const top = chosen[0].score;
  for (const scored of chosen.slice(1)) assert.ok(scored.score >= 0.75 * top);
  const capped = selectRelevant(index, "Bell state", { typicalChars: 10, ceilingChars: 10 });
  assert.deepEqual(capped, []);
});

// ---- Dive sources ----------------------------------------------------------

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

function book() {
  const index = buildTextIndex([
    page(1, [...filler("history of computing", 8)]),
    page(2, ["Entanglement is a correlation between qubits that no classical system shows.", ...filler("notation", 6)]),
    page(3, [...filler("measurement", 4), "Entanglement links two qubits so their outcomes correlate.", ...filler("measurement", 4)]),
    page(4, [...filler("classical circuits", 8)]),
  ]);
  const chunks = chunkDocument(index);
  return { index, chunks, bm25: buildBm25(chunks) };
}

test("a root dive gets the chunk holding the selection plus relevant chunks elsewhere", () => {
  const { index, chunks, bm25 } = book();
  const sources = buildDiveSources({ index, chunks, bm25, selection: "Entanglement links two qubits", pageNumber: 3 });
  assert.ok(sources.some((s) => s.pageNumber === 3 && s.text.includes("Entanglement links two qubits")));
  // Entanglement is defined on page 2: relevant, so it comes along.
  assert.ok(sources.some((s) => s.pageNumber === 2 && s.text.includes("Entanglement is a correlation")));
  // Nothing about classical circuits.
  assert.ok(!sources.some((s) => s.pageNumber === 4));
  // Labeled in document order.
  assert.deepEqual(
    sources.map((s) => s.label),
    sources.map((_, i) => `S${i + 1}`),
  );
  assert.ok(sources.every((s, i) => i === 0 || sources[i - 1].pageNumber <= s.pageNumber));
});

test("a nested dive keeps the parent's cited sources and adds relevant ones", () => {
  const { index, chunks, bm25 } = book();
  const inherited = [{ ...source("S9", 3, "Entanglement links two qubits so their outcomes correlate.", 10), chunkId: "p3-0" }];
  const sources = buildDiveSources({ index, chunks, bm25, selection: "entanglement", pageNumber: null, inherited });
  assert.ok(sources.some((s) => s.chunkId === "p3-0"));
  assert.ok(sources.some((s) => s.pageNumber === 2));
  assert.equal(sources[0].label, "S1");
});

test("renderSources labels each passage with its id and page label", () => {
  const rendered = renderSources([source("S1", 5, "Text.")], (n) => ["i", "ii", "iii", "iv", "v"][n - 1]);
  assert.equal(rendered, '<source id="S1" p="v">Text.</source>');
});

test("labelSources orders by page then position", () => {
  const labeled = labelSources([source("", 3, "c"), source("", 1, "b", 50), source("", 1, "a", 10)]);
  assert.deepEqual(
    labeled.map((s) => [s.label, s.text]),
    [
      ["S1", "a"],
      ["S2", "b"],
      ["S3", "c"],
    ],
  );
});

// ---- Citations ---------------------------------------------------------------

const SOURCES = [
  source("S1", 42, "A Bell state is a maximally entangled state of two qubits. It has four forms.", 100),
  source("S2", 43, "All four are built from |00> with a Hadamard then a CNOT.", 0),
];

test("parses stated, inferred and general citations, merging adjacent ones", () => {
  const answer =
    "A Bell state is maximally entangled [S1]. The circuit makes all four [inferred: S2]. It powers teleportation [general]. See both [S1][S2].";
  const parsed = parseAnswer(answer, SOURCES);
  assert.deepEqual(
    parsed.groups.map((g) => [g.kind, g.labels, g.claim]),
    [
      ["stated", ["S1"], "A Bell state is maximally entangled"],
      ["inferred", ["S2"], "The circuit makes all four"],
      ["general", [], "It powers teleportation"],
      ["stated", ["S1", "S2"], "See both"],
    ],
  );
  assert.equal(answerGrounding(parsed), "mixed");
});

test("a marker after the full stop cites the sentence before it", () => {
  const parsed = parseAnswer("First claim. Second claim. [S2]", SOURCES);
  assert.equal(parsed.groups[0].claim, "Second claim.");
});

test("citations to ids that weren't sent are unverified and cost the badge", () => {
  const parsed = parseAnswer("Something [S7].", SOURCES);
  assert.equal(parsed.groups[0].kind, "unverified");
  assert.equal(answerGrounding(parseAnswer("Fine [S1]. Bad [S9].", SOURCES)), "mixed");
});

test("badge: document, inferred, general, not covered", () => {
  assert.equal(answerGrounding(parseAnswer("One [S1]. Two [S1, S2].", SOURCES)), "document");
  assert.equal(answerGrounding(parseAnswer("One [S1]. Two [inferred:S2].", SOURCES)), "inferred");
  assert.equal(answerGrounding(parseAnswer("No citations at all.", SOURCES)), "general");
  assert.equal(answerGrounding(parseAnswer("[not-covered] The document doesn't discuss this.", SOURCES)), "not-covered");
});

test("quotes must appear in the cited source", () => {
  const real = parseAnswer('The text calls it "a maximally entangled state of two qubits" [S1].', SOURCES);
  assert.equal(real.groups[0].quoteMissing, false);
  const fake = parseAnswer('The text calls it "the most entangled pair in nature" [S1].', SOURCES);
  assert.equal(fake.groups[0].quoteMissing, true);
  assert.equal(answerGrounding(fake), "mixed");
});

test("localizeClaim picks the supporting sentence, in page offsets", () => {
  const [start, end] = localizeClaim("There are four forms", SOURCES[0]);
  assert.equal(SOURCES[0].text.slice(start - 100, end - 100), "It has four forms.");
  // No overlap: the whole source.
  assert.deepEqual(localizeClaim("Unrelated words entirely", SOURCES[0]), [100, SOURCES[0].end]);
});

test("toChipMarkdown turns citations into empty links that carry kind, pages and flash range", () => {
  const out = toChipMarkdown("Four forms exist [S1]. From |00> [inferred: S2][general].", SOURCES, 3, (n) => `${n}`);
  assert.match(out, /^Four forms exist\[\]\(#cite:3:stated:S1\.\d+\.\d+ "p\. 42"\)\./);
  assert.match(out, /\[\]\(#cite:3:inferred:S2\.\d+\.\d+ "p\. 43"\)\[\]\(#cite:3:general: "general"\)\.$/);
  const href = /\((#cite:3:stated:[^ ]+) /.exec(out)![1];
  const target = decodeChipTarget(href)!;
  assert.equal(target.kind, "stated");
  assert.equal(target.refs[0].label, "S1");
  assert.equal(SOURCES[0].text.slice(target.refs[0].start - 100, target.refs[0].end - 100), "It has four forms.");
});

test("toChipMarkdown drops [not-covered] and merges pages in one chip", () => {
  assert.equal(toChipMarkdown("[not-covered] Not discussed here.", SOURCES, 0, pageLabel), "Not discussed here.");
  const merged = toChipMarkdown("Both say so [S1][S2].", SOURCES, 0, pageLabel);
  assert.match(merged, /"pp\. 42, 43"\)\.$/);
  assert.equal((merged.match(/#cite/g) ?? []).length, 1);
});

test("markersToPages rewrites old markers for conversation history", () => {
  assert.equal(
    markersToPages("Four forms [S1]. Built from |00> [inferred: S2]. Also [general]. Gone [S9].", SOURCES, pageLabel),
    "Four forms (p. 42). Built from |00> (p. 43). Also. Gone.",
  );
});

test("trimPartialMarker hides a marker still streaming in, and nothing else", () => {
  assert.equal(trimPartialMarker("Bell states are entangled [S"), "Bell states are entangled ");
  assert.equal(trimPartialMarker("It follows [infer"), "It follows ");
  assert.equal(trimPartialMarker("Known [gen"), "Known ");
  assert.equal(trimPartialMarker("Done [S1]."), "Done [S1].");
  assert.equal(trimPartialMarker("A matrix [a"), "A matrix [a");
  assert.equal(trimPartialMarker("No brackets"), "No brackets");
});

test("citedSources lists only sources the answer cited", () => {
  assert.deepEqual(
    citedSources("Only this [S2].", SOURCES).map((s) => s.label),
    ["S2"],
  );
});

// ---- Ask ---------------------------------------------------------------------


test("wantsWholeScope spots questions about a scope as a whole", () => {
  for (const q of [
    "Summarize this chapter",
    "What is the main argument?",
    "What is this paper about?",
    "List all the theorems in this section",
    "Give me an overview",
    "What are the key takeaways?",
  ]) {
    assert.ok(wantsWholeScope(q), q);
  }
  for (const q of ["How is a Bell state prepared?", "Why does entanglement matter here?", "Define qubit"]) {
    assert.ok(!wantsWholeScope(q), q);
  }
});

test("a pointed question sends the relevant passages only", () => {
  const { chunks, bm25 } = book();
  const { sources, basis } = selectAskSources({ chunks, bm25, question: "What does entanglement link?", scope: { kind: "document" } });
  assert.equal(basis.kind, "passages");
  assert.ok(sources.length >= 1 && sources.length < chunks.length);
  assert.ok(sources.every((s) => /entangle/i.test(s.text)));
});

test("a question about the whole scope sends all of it", () => {
  const { chunks, bm25 } = book();
  const chapter: AskScope = { kind: "section", title: "Chapter 2", from: 2, to: 3 };
  const { sources, basis } = selectAskSources({ chunks, bm25, question: "Summarize this chapter", scope: chapter });
  assert.equal(basis.kind, "scope");
  assert.deepEqual(
    [...new Set(sources.map((s) => s.pageNumber))],
    [2, 3],
  );
});

test("nothing relevant sends nothing, so the model can be skipped", () => {
  const { chunks, bm25 } = book();
  const { sources, basis } = selectAskSources({ chunks, bm25, question: "What is photosynthesis?", scope: { kind: "document" } });
  assert.deepEqual(sources, []);
  assert.equal(basis.kind, "none");
});

test("scope limits which passages can be chosen", () => {
  const { chunks, bm25 } = book();
  const { sources } = selectAskSources({ chunks, bm25, question: "entanglement qubits", scope: { kind: "page", page: 2 } });
  assert.ok(sources.length > 0 && sources.every((s) => s.pageNumber === 2));
});

test("a follow-up searches with the previous question too", () => {
  const { chunks, bm25 } = book();
  const alone = selectAskSources({ chunks, bm25, question: "Why?", scope: { kind: "document" } });
  assert.equal(alone.basis.kind, "none");
  const followUp = selectAskSources({
    chunks,
    bm25,
    question: "Why?",
    previousQuestion: "What does entanglement link?",
    scope: { kind: "document" },
  });
  assert.ok(followUp.sources.length > 0);
  // An unrelated question isn't answered from the previous one's passages.
  const unrelated = selectAskSources({
    chunks,
    bm25,
    question: "What is photosynthesis?",
    previousQuestion: "What does entanglement link?",
    scope: { kind: "document" },
  });
  assert.equal(unrelated.basis.kind, "none");
});

test("buildAskSystem puts sources first and adds the general-knowledge rule only when asked", () => {
  const sources = [source("S1", 2, "Entanglement is a correlation.")];
  const base = { fileName: "q.pdf", scope: { kind: "document" } as AskScope, basis: { kind: "passages", count: 1 } as const, sources, pageLabel };
  const system = buildAskSystem({ ...base, generalAllowed: false });
  assert.ok(system.indexOf("<source") < system.indexOf("How to answer"));
  assert.ok(!system.includes("Don't reply [not-covered]"));
  assert.ok(buildAskSystem({ ...base, generalAllowed: true }).includes("Don't reply [not-covered]"));
  // Math is written like in Deep Dive: LaTeX, never copied from garbled source text.
  assert.ok(system.includes(MATH_RULES));
});

// ---- Attachments ----------------------------------------------------------------


test("makeAttachment cleans, caps and rejects empty text", () => {
  assert.equal(makeAttachment("answer", "   \n "), null);
  const long = makeAttachment("document", "word ".repeat(2000), 3)!;
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= ATTACHMENT_MAX_CHARS + 1);
  assert.equal(makeAttachment("answer", "a  b\n c")!.text, "a b c");
});

test("addAttachment skips duplicates and keeps the newest few", () => {
  const one = makeAttachment("answer", "same")!;
  let list = addAttachment([], one);
  list = addAttachment(list, { ...makeAttachment("answer", "same")! });
  assert.equal(list.length, 1);
  for (let i = 0; i < MAX_ATTACHMENTS + 2; i += 1) list = addAttachment(list, makeAttachment("answer", `t${i}`)!);
  assert.equal(list.length, MAX_ATTACHMENTS);
  assert.equal(list[list.length - 1].text, `t${MAX_ATTACHMENTS + 1}`);
});

test("document attachments become sources located on their page; answer text doesn't", () => {
  const { index } = book();
  const sources = attachmentSources(
    [
      makeAttachment("document", "Entanglement links two qubits", 3)!,
      makeAttachment("document", "text the extraction mangled beyond recognition", 3)!,
      makeAttachment("answer", "an earlier explanation")!,
    ],
    index,
  );
  assert.equal(sources.length, 2);
  const page = index.pages[2];
  assert.equal(page.text.slice(sources[0].start, sources[0].end), "Entanglement links two qubits");
  // Not found on the page: still a source for that page, jumping to the page only.
  assert.deepEqual([sources[1].pageNumber, sources[1].start, sources[1].end], [3, 0, 0]);
});

test("attached passages are always sent to Ask, and not duplicated by retrieval", () => {
  const { index, chunks, bm25 } = book();
  const attached = attachmentSources([makeAttachment("document", "Entanglement links two qubits", 3)!], index);
  const { sources, basis } = selectAskSources({
    chunks,
    bm25,
    question: "Explain this",
    scope: { kind: "document" },
    attached,
    extraQuery: "Entanglement links two qubits",
  });
  assert.equal(basis.kind, "passages");
  const pinned = sources.filter((s) => !s.chunkId);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].text, "Entanglement links two qubits");
  // Related text elsewhere came along (page 2 defines entanglement).
  assert.ok(sources.some((s) => s.pageNumber === 2));
});

test("a dive follow-up keeps attached passages and drops chunks covering them", () => {
  const { index, chunks, bm25 } = book();
  const attached = attachmentSources([makeAttachment("document", "Entanglement links two qubits", 3)!], index);
  const sources = buildDiveSources({ index, chunks, bm25, selection: "Entanglement links two qubits", pageNumber: 3, attached });
  assert.equal(sources.filter((s) => !s.chunkId).length, 1);
  assert.ok(!sources.some((s) => s.chunkId && s.pageNumber === 3 && s.start <= attached[0].start && s.end >= attached[0].end));
});

test("attachmentInstructions names attached sources and quotes answer text as context only", () => {
  const note = attachmentInstructions(
    [makeAttachment("document", "x", 1)!, makeAttachment("answer", "Earlier the model said so.")!],
    ["S2"],
  );
  assert.match(note, /attached S2 to their question: answer about that first/);
  assert.match(note, /context only — not a source, don't cite it/);
  assert.match(note, /Earlier the model said so\./);
  assert.equal(attachmentInstructions([], []), "");
});

// ---- Scope inference ----------------------------------------------------------------

const SCOPE_CONTEXT: ScopeContext = {
  currentPage: 14,
  numPages: 60,
  pageLabels: null,
  sections: [
    { title: "1 Basics", depth: 0, pageNumber: 1 },
    { title: "1.1 States", depth: 1, pageNumber: 3 },
    { title: "2 Entanglement", depth: 0, pageNumber: 10 },
    { title: "2.1 Bell states", depth: 1, pageNumber: 12 },
    { title: "2.2 Teleportation", depth: 1, pageNumber: 18 },
    { title: "Chapter 3: Algorithms", depth: 0, pageNumber: 25 },
    { title: "Algorithms in practice", depth: 0, pageNumber: 45 },
    { title: "Appendix A", depth: 0, pageNumber: 50 },
  ],
};

test("inferScope reads the scope from the question, defaulting to the whole document", () => {
  const scope = (q: string) => inferScope(q, SCOPE_CONTEXT);
  assert.deepEqual(scope("How is a Bell state prepared?"), { kind: "document" });
  assert.deepEqual(scope("Explain the figure on this page"), { kind: "page", page: 14 });
  assert.deepEqual(scope("What does page 20 say about noise?"), { kind: "page", page: 20 });
  assert.deepEqual(scope("summarize pp. 12-15"), { kind: "section", title: "pp. 12–15", from: 12, to: 15 });
  assert.deepEqual(scope("Summarize this chapter"), { kind: "section", title: "2 Entanglement", from: 10, to: 24 });
  assert.deepEqual(scope("What is this section about?"), { kind: "section", title: "2.1 Bell states", from: 12, to: 17 });
  assert.deepEqual(scope("Main idea of chapter 3?"), { kind: "section", title: "Chapter 3: Algorithms", from: 25, to: 44 });
  assert.deepEqual(scope("What's in section 1.1?"), { kind: "section", title: "1.1 States", from: 3, to: 9 });
  assert.deepEqual(scope("What's in appendix A?"), { kind: "section", title: "Appendix A", from: 50, to: 60 });
  // Out of range or unknown: fall back to the whole document.
  assert.deepEqual(scope("What is on page 900?"), { kind: "document" });
  assert.deepEqual(scope("Summarize chapter 9"), { kind: "document" });
});

test("inferScope understands printed page labels", () => {
  const labels = ["i", "ii", "iii", ...Array.from({ length: 57 }, (_, i) => String(i + 1))];
  const context = { ...SCOPE_CONTEXT, pageLabels: labels };
  assert.deepEqual(inferScope("What is on page ii?", context), { kind: "page", page: 2 });
  assert.deepEqual(inferScope("see p. 10", context), { kind: "page", page: 13 });
});

test("a citation left alone after a display equation loses the orphaned full stop", () => {
  const out = toChipMarkdown("It holds, since\n\n$$\nx = 1\n$$\n\n [S1].", SOURCES, 0, pageLabel);
  assert.match(out, /\$\$\n\n\[\]\(#cite:0:stated:[^)]*\)$/);
});

// ---- Region attachments -------------------------------------------------------

const IMAGE = { mediaType: "image/jpeg", data: "AAAA" };
// Page 3 of book(): lines at top = 100 + 15·i, 600×800. The region covers
// the lines at i = 4 (top 160) only: y from 158 to 172 → scaled over 800.
const REGION = { x1: 60, y1: 158, x2: 580, y2: 172, width: 600, height: 800 };

test("regionTextRange finds the page text inside a region", () => {
  const { index } = book();
  const page = index.pages[2];
  const range = regionTextRange(page, REGION)!;
  assert.equal(page.text.slice(range[0], range[1]), "Entanglement links two qubits so their outcomes correlate.");
  assert.equal(regionTextRange(page, { ...REGION, y1: 700, y2: 790 }), null);
  // A box around the start of the line takes just that part of it: the line
  // runs from x = 72 at 6 per character, so x 72–150 is its first 13.
  const part = regionTextRange(page, { ...REGION, x2: 150 })!;
  assert.equal(page.text.slice(part[0], part[1]), "Entanglement");
});

test("a region attachment carries its image, and its text as a citable source", () => {
  const { index } = book();
  const withText = makeRegionAttachment(IMAGE, 3, index.pages[2], REGION);
  const pictureOnly = makeRegionAttachment({ ...IMAGE, data: "BBBB" }, 3, index.pages[2], { ...REGION, y1: 700, y2: 790 });
  assert.equal(withText.kind, "region");
  assert.equal(pictureOnly.text, "");
  const sources = attachmentSources([withText, pictureOnly], index);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].text, "Entanglement links two qubits so their outcomes correlate.");
  assert.equal(index.pages[2].text.slice(sources[0].start, sources[0].end), sources[0].text);
  assert.deepEqual(attachmentImages([withText, pictureOnly, makeAttachment("answer", "x")!]).map((i) => i.data), ["AAAA", "BBBB"]);
  assert.match(attachmentInstructions([withText, pictureOnly], ["S1"], (n) => `${n}`), /2 images of regions of the document \(p\. 3\)/);
});

test("the same region isn't attached twice; different regions are", () => {
  const { index } = book();
  const a = makeRegionAttachment(IMAGE, 3, index.pages[2], REGION);
  let list = addAttachment([], a);
  list = addAttachment(list, { ...a, id: "other" });
  assert.equal(list.length, 1);
  list = addAttachment(list, makeRegionAttachment({ ...IMAGE, data: "CCCC" }, 3, null, REGION));
  assert.equal(list.length, 2);
});
