import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex, matchPosition } from "../glossary/textIndex.ts";
import { compactPages, expandPages, TEXT_CACHE_VERSION } from "./cache.ts";
import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, chunkDocument, chunkPage, sentenceBoundaries } from "./chunks.ts";
import {
  buildSections,
  formatSectionPath,
  sectionPageRange,
  sectionPathAt,
  type OutlineNode,
  type Section,
} from "./sections.ts";

const LINE_HEIGHT = 12;
const CHAR_WIDTH = 6;

// A page whose text is `lines`, one text run per line, CHAR_WIDTH per
// character — laid out the way pdf.js reports a simple single-column page.
function page(pageNumber: number, lines: string[]): PdfExtractedPage {
  return {
    pageNumber,
    width: 600,
    height: 800,
    textItems: lines.map((text, index) => ({
      text,
      index,
      pageNumber,
      rect: { left: 72.123456, top: 100 + index * 15, width: text.length * CHAR_WIDTH, height: LINE_HEIGHT, pageNumber },
    })),
  };
}

// `count` distinct sentences of roughly `length` characters each.
function sentences(count: number, length = 90): string[] {
  return Array.from({ length: count }, (_, i) => {
    const head = `Sentence ${i + 1} states a fact`;
    return `${head}${" about qubits".repeat(Math.max(0, Math.ceil((length - head.length - 1) / 13)))}.`;
  });
}

// ---- Sentences --------------------------------------------------------------

test("sentence boundaries skip abbreviations, initials and decimals", () => {
  const text =
    "See Fig. 3 and Eq. 2 for details. Smith et al. (2020) disagree, e.g. on noise. J. Bell proved it. The value is 3.14 here! Next one? Yes.";
  const cuts = sentenceBoundaries(text);
  const pieces = [0, ...cuts].map((start, i) => text.slice(start, cuts[i] ?? text.length).trim());
  assert.deepEqual(pieces, [
    "See Fig. 3 and Eq. 2 for details.",
    "Smith et al. (2020) disagree, e.g. on noise.",
    "J. Bell proved it.",
    "The value is 3.14 here!",
    "Next one?",
    "Yes.",
  ]);
});

// ---- Chunks -----------------------------------------------------------------

test("chunks pack whole sentences between the minimum and maximum size", () => {
  const index = buildTextIndex([page(1, sentences(20))]);
  const chunks = chunkPage(index.pages[0]);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.text.length >= CHUNK_MIN_CHARS, `too short: ${chunk.text.length}`);
    assert.ok(chunk.text.length <= CHUNK_MAX_CHARS, `too long: ${chunk.text.length}`);
    assert.match(chunk.text, /^Sentence \d+ .*\.$/);
  }
  // Nothing lost or duplicated: the chunks tile the page text.
  assert.equal(chunks.map((c) => c.text).join(" "), index.pages[0].text);
});

test("chunk offsets point at their text, and map back to on-page rectangles", () => {
  const index = buildTextIndex([page(1, sentences(12)), page(2, sentences(3))]);
  const chunks = chunkDocument(index);
  for (const chunk of chunks) {
    const indexedPage = index.pages[chunk.pageNumber - 1];
    assert.equal(indexedPage.text.slice(chunk.start, chunk.end), chunk.text);
    const position = matchPosition({ page: indexedPage, start: chunk.start, end: chunk.end });
    assert.ok(position, `no position for ${chunk.id}`);
    assert.equal(position.boundingRect.pageNumber, chunk.pageNumber);
  }
});

test("chunks never cross a page, and ids name page and order", () => {
  const index = buildTextIndex([page(1, sentences(2)), page(2, sentences(2)), page(3, [])]);
  const chunks = chunkDocument(index);
  assert.deepEqual(
    chunks.map((c) => c.id),
    ["p1-0", "p2-0"],
  );
});

test("an over-long sentence is split at word breaks", () => {
  const long = `${"entangled qubit pairs ".repeat(80).trim()}.`;
  const index = buildTextIndex([page(1, [long])]);
  const chunks = chunkPage(index.pages[0]);
  assert.ok(chunks.length >= 2);
  const { text } = index.pages[0];
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= CHUNK_MAX_CHARS);
    // Cut between words, never inside one.
    assert.ok(chunk.end === text.length || text[chunk.end] === " ", `cut mid-word at ${chunk.end}`);
  }
  assert.equal(chunks.map((c) => c.text).join(" "), index.pages[0].text);
});

test("a short tail joins the chunk before it", () => {
  const index = buildTextIndex([page(1, [...sentences(6), "Short end."])]);
  const chunks = chunkPage(index.pages[0]);
  assert.ok(chunks[chunks.length - 1].text.endsWith("Short end."));
  assert.ok(chunks[chunks.length - 1].text.length > "Short end.".length);
});

// ---- Text cache ---------------------------------------------------------------

const IDENTITY = { fingerprint: "abc", numPages: 2 };

test("the text cache round-trips to the same index", () => {
  const pages = [page(1, sentences(4)), page(2, ["Running head", ...sentences(2)])];
  const restored = expandPages(JSON.parse(JSON.stringify(compactPages(pages, IDENTITY))), IDENTITY);
  assert.ok(restored);
  const fresh = buildTextIndex(pages);
  const cached = buildTextIndex(restored);
  assert.deepEqual(
    cached.pages.map((p) => [p.text, p.charItem, p.charOffset]),
    fresh.pages.map((p) => [p.text, p.charItem, p.charOffset]),
  );
  assert.equal(restored[0].textItems[0].rect.left, 72.12); // rounded to 1/100 pt
});

test("a cache from another version or PDF is ignored", () => {
  const cached = compactPages([page(1, ["x"])], IDENTITY);
  assert.equal(expandPages({ ...cached, version: TEXT_CACHE_VERSION + 1 }, IDENTITY), null);
  assert.equal(expandPages(cached, { ...IDENTITY, fingerprint: "other" }), null);
  assert.equal(expandPages(cached, { ...IDENTITY, numPages: 3 }), null);
  assert.equal(expandPages(null, IDENTITY), null);
});

// ---- Sections -----------------------------------------------------------------

function node(title: string, dest: OutlineNode["dest"], items: OutlineNode[] = []): OutlineNode {
  return { title, dest, items };
}

test("buildSections flattens the outline, resolving named and explicit destinations", async () => {
  const refs = new Map([["ref-3", 2], ["ref-9", 8]]);
  const sections = await buildSections({
    numPages: 20,
    getOutline: async () => [
      node("1  Introduction", [{ ref: "ref-3" }]),
      node("2 Entanglement", "named-9", [node("2.1 Bell states", [4]), node("Web link", null)]),
    ],
    getDestination: async (id) => (id === "named-9" ? [{ ref: "ref-9" }] : null),
    getPageIndex: async (ref) => refs.get((ref as { ref: string }).ref) ?? -1,
  });
  assert.deepEqual(sections, [
    { title: "1 Introduction", depth: 0, pageNumber: 3 },
    { title: "2 Entanglement", depth: 0, pageNumber: 9 },
    { title: "2.1 Bell states", depth: 1, pageNumber: 5 },
  ]);
});

test("a PDF without an outline has no sections", async () => {
  const none = await buildSections({
    numPages: 1,
    getOutline: async () => null,
    getDestination: async () => null,
    getPageIndex: async () => 0,
  });
  assert.deepEqual(none, []);
});

const SECTIONS: Section[] = [
  { title: "1 Basics", depth: 0, pageNumber: 1 },
  { title: "1.1 States", depth: 1, pageNumber: 2 },
  { title: "1.1.1 Kets", depth: 2, pageNumber: 3 },
  { title: "1.2 Gates", depth: 1, pageNumber: 5 },
  { title: "2 Entanglement", depth: 0, pageNumber: 8 },
  { title: "2.0.1 Aside", depth: 2, pageNumber: 9 },
];

test("sectionPathAt gives the enclosing sections, outermost first", () => {
  assert.equal(formatSectionPath(sectionPathAt(SECTIONS, 4)), "1 Basics › 1.1 States › 1.1.1 Kets");
  assert.equal(formatSectionPath(sectionPathAt(SECTIONS, 6)), "1 Basics › 1.2 Gates");
  assert.equal(formatSectionPath(sectionPathAt(SECTIONS, 9)), "2 Entanglement › 2.0.1 Aside");
  assert.deepEqual(sectionPathAt(SECTIONS, 0), []);
});

test("sectionPageRange runs to the next section at the same or shallower depth", () => {
  assert.deepEqual(sectionPageRange(SECTIONS, 0, 12), [1, 7]);
  assert.deepEqual(sectionPageRange(SECTIONS, 1, 12), [2, 4]);
  assert.deepEqual(sectionPageRange(SECTIONS, 4, 12), [8, 12]);
  assert.deepEqual(
    sectionPageRange([{ title: "A", depth: 0, pageNumber: 3 }, { title: "B", depth: 0, pageNumber: 3 }], 0, 5),
    [3, 3],
  );
});
