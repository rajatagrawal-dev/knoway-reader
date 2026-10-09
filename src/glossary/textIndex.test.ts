import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import {
  buildTermMatcher,
  buildTextIndex,
  cleanTerm,
  findDefiningMatch,
  findRelatedMatches,
  findTermMarksOnPage,
  findTermMatches,
  findTextMatches,
  mergeMatches,
  isGlossaryCandidate,
  matchPosition,
  selectExcerpts,
  snippetAround,
  termKey,
} from "./textIndex.ts";

const PAGE_WIDTH = 600;
const PAGE_HEIGHT = 800;
const LINE_HEIGHT = 12;
const CHAR_WIDTH = 6;

// A run of text at (left, top), CHAR_WIDTH per character.
type Run = [text: string, left: number, top: number];

function page(pageNumber: number, runs: Run[]): PdfExtractedPage {
  return {
    pageNumber,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    textItems: runs.map(([text, left, top], index) => ({
      text,
      index,
      pageNumber,
      rect: { left, top, width: text.length * CHAR_WIDTH, height: LINE_HEIGHT, pageNumber },
    })),
  };
}

function texts(pages: PdfExtractedPage[]): string[] {
  return buildTextIndex(pages).pages.map((p) => p.text);
}

test("joins runs split mid-word on one line, and spaces runs apart when there's a gap", () => {
  assert.deepEqual(texts([page(1, [["super", 100, 200], ["position", 130, 200], ["holds", 190, 200]])]), [
    "superposition holds",
  ]);
});

test("separates the last word of a line from the first word of the next", () => {
  assert.deepEqual(texts([page(1, [["quantum", 100, 200], ["state", 100, 215]])]), ["quantum state"]);
});

test("rejoins a word hyphenated across a line break", () => {
  const index = buildTextIndex([page(1, [["quantum entan-", 100, 200], ["glement is", 100, 215]])]);
  assert.equal(index.pages[0].text, "quantum entanglement is");
  const matches = findTermMatches(index, "entanglement");
  assert.equal(matches.length, 1);
  // One rect per line the word spans.
  assert.equal(matchPosition(matches[0])?.rects.length, 2);
});

test("keeps a hyphen that isn't a line-break hyphenation", () => {
  assert.deepEqual(texts([page(1, [["two-", 100, 200], ["Qubit gate", 100, 215]])]), ["two- Qubit gate"]);
});

test("expands ligatures and straightens quotes", () => {
  assert.deepEqual(texts([page(1, [["the ﬁeld’s “state”", 100, 200]])]), [`the field's "state"`]);
});

test("drops running heads and page numbers from the margins", () => {
  const pages = [1, 2, 3].map((n) =>
    page(n, [
      [`CHAPTER 2. QUBITS ${n + 10}`, 100, 20],
      ["A qubit is a two-level system.", 100, 300],
      [String(n + 10), 290, 780],
    ]),
  );
  const index = buildTextIndex(pages);
  assert.deepEqual(
    index.pages.map((p) => p.text),
    ["A qubit is a two-level system.", "A qubit is a two-level system.", "A qubit is a two-level system."],
  );
  assert.equal(findTermMatches(index, "Qubits").length, 3);
});

test("keeps a margin line that doesn't repeat across pages", () => {
  assert.deepEqual(texts([page(1, [["Qubits", 100, 20], ["body", 100, 300]])]), ["Qubits body"]);
});

test("matches singular, plural and possessive forms on word boundaries only", () => {
  const index = buildTextIndex([page(1, [["A qubit, two qubits, the qubit's phase, qubitization.", 100, 200]])]);
  assert.deepEqual(
    findTermMatches(index, "Qubits").map((m) => index.pages[0].text.slice(m.start, m.end)),
    ["qubit", "qubits", "qubit's"],
  );
});

test("matches -y/-ies plurals", () => {
  const index = buildTextIndex([page(1, [["one probability, two probabilities", 100, 200]])]);
  assert.equal(findTermMatches(index, "probability").length, 2);
  assert.equal(findTermMatches(index, "probabilities").length, 2);
});

test("matches a multi-word term across spaces, hyphens and line breaks", () => {
  const index = buildTextIndex([
    page(1, [["a well-known result, a well known one, a well", 100, 200], ["known fact", 100, 215]]),
  ]);
  assert.equal(findTermMatches(index, "well-known").length, 3);
});

test("matches acronyms case-sensitively", () => {
  const index = buildTextIndex([page(1, [["The QFT of it is IT, and QFTs too.", 100, 200]])]);
  assert.equal(findTermMatches(index, "IT").length, 1);
  assert.equal(findTermMatches(index, "QFT").length, 2);
});

test("finds matches across pages in document order", () => {
  const index = buildTextIndex([page(1, [["gate one", 100, 200]]), page(2, [["gate two, gate three", 100, 200]])]);
  assert.deepEqual(
    findTermMatches(index, "gate").map((m) => [m.page.pageNumber, m.start]),
    [
      [1, 0],
      [2, 0],
      [2, 10],
    ],
  );
});

test("positions a match within its run, in page coordinates", () => {
  const index = buildTextIndex([page(3, [["the qubit here", 100, 200]])]);
  const [match] = findTermMatches(index, "qubit");
  const position = matchPosition(match);
  assert.deepEqual(position?.boundingRect, {
    x1: 100 + 4 * CHAR_WIDTH,
    y1: 200,
    x2: 100 + 9 * CHAR_WIDTH,
    y2: 200 + LINE_HEIGHT,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    pageNumber: 3,
  });
});

test("cleans selections into terms and dedupes them by key", () => {
  assert.equal(cleanTerm("  “Entanglement,” "), "Entanglement");
  assert.equal(cleanTerm("(Bell  state)."), "Bell state");
  assert.equal(termKey("Qubits"), termKey("qubit"));
  assert.equal(termKey("qubit's"), termKey("qubit"));
  assert.equal(termKey("Probabilities"), termKey("probability"));
  assert.notEqual(termKey("process"), termKey("proces"));
});

test("only short selections are glossary candidates", () => {
  assert.equal(isGlossaryCandidate("density matrix"), true);
  assert.equal(isGlossaryCandidate("  ,  "), false);
  assert.equal(isGlossaryCandidate("one two three four five six seven eight nine"), false);
});

test("snippets are cut back to whole words with ellipses", () => {
  const index = buildTextIndex([page(1, [["alpha beta gamma qubit delta epsilon zeta", 100, 200]])]);
  const [match] = findTermMatches(index, "qubit");
  assert.deepEqual(snippetAround(match, 8), { before: "…gamma ", match: "qubit", after: " delta…" });
});

test("excerpts prefer where the term is defined, and the reader's own page", () => {
  const index = buildTextIndex([
    page(1, [["We use a qubit here.", 100, 200]]),
    page(2, [["A qubit is a two-level quantum system.", 100, 200]]),
    page(3, [["Measure the qubit.", 100, 200]]),
    page(4, [["Another qubit appears.", 100, 200]]),
  ]);
  const matches = findTermMatches(index, "qubit");
  assert.deepEqual(
    selectExcerpts(matches, 4, 2).map((m) => m.page.pageNumber),
    [2, 4],
  );
});

test("the defining match is the one whose wording defines the term, wherever the reader is", () => {
  const index = buildTextIndex([
    page(1, [["The qubit is measured twice.", 100, 200]]),
    page(2, [["A qubit is a two-level quantum system.", 100, 200]]),
    page(3, [["A two-level system known as a qubit.", 100, 200]]),
  ]);
  const defining = findDefiningMatch(findTermMatches(index, "qubit"));
  assert.equal(defining?.page.pageNumber, 3);
});

test("no defining match when no excerpt reads like a definition", () => {
  const index = buildTextIndex([
    page(1, [["The qubit is measured twice.", 100, 200]]),
    page(2, [["This gate is a qubit rotation.", 100, 200]]),
  ]);
  assert.equal(findDefiningMatch(findTermMatches(index, "qubit")), undefined);
});

test("excerpts skip near-duplicates from the same stretch of a page", () => {
  const index = buildTextIndex([page(1, [["qubit qubit qubit", 100, 200]]), page(2, [["qubit", 100, 200]])]);
  assert.deepEqual(
    selectExcerpts(findTermMatches(index, "qubit"), 1, 5).map((m) => m.page.pageNumber),
    [1, 2],
  );
});

test("related forms find a definition given for a different form of the term", () => {
  const index = buildTextIndex([
    page(1, [["We use entanglement here.", 100, 200]]),
    page(2, [["We say such a state is an entangled state; entangling gates create one.", 100, 200]]),
    page(3, [["More entanglement appears.", 100, 200]]),
  ]);
  const related = findRelatedMatches(index, "entanglement");
  assert.deepEqual(
    related.map((m) => m.page.text.slice(m.start, m.end)),
    ["entangled", "entangling"],
  );
  assert.ok(related.every((m) => m.related));
  const chosen = selectExcerpts(mergeMatches(findTermMatches(index, "entanglement"), related), 3, 2);
  assert.deepEqual(
    chosen.map((m) => m.page.pageNumber),
    [2, 3],
  );
});

test("related forms are skipped for short stems and acronyms", () => {
  const index = buildTextIndex([page(1, [["gates gated QFTs", 100, 200]])]);
  assert.deepEqual(findRelatedMatches(index, "gates"), []);
  assert.deepEqual(findRelatedMatches(index, "QFT"), []);
});

test("marks every glossary term on a page, related forms included, longest first", () => {
  const index = buildTextIndex([
    page(1, [["The density operator of an entangled pair; an operator shows entanglement.", 100, 200]]),
  ]);
  const terms = [
    { id: "op", matcher: buildTermMatcher("operator")! },
    { id: "rho", matcher: buildTermMatcher("density operator")! },
    { id: "ent", matcher: buildTermMatcher("entanglement")! },
  ];
  const marks = findTermMarksOnPage(index.pages[0], terms);
  assert.deepEqual(
    marks.map((m) => [m.id, index.pages[0].text.slice(m.start, m.end), Boolean(m.related)]),
    [
      ["rho", "density operator", false],
      ["ent", "entangled", true],
      ["op", "operator", false],
      ["ent", "entanglement", false],
    ],
  );
});

test("finds plain-text search matches anywhere, case-insensitively, across pages", () => {
  const index = buildTextIndex([
    page(1, [["Quantum states and superstates", 100, 200]]),
    page(2, [["A STATE of", 100, 200], ["mind", 100, 220]]),
  ]);
  const found = (query: string) =>
    findTextMatches(index, query).map((m) => [m.page.pageNumber, m.page.text.slice(m.start, m.end)]);
  assert.deepEqual(found("state"), [
    [1, "state"],
    [1, "state"],
    [2, "STATE"],
  ]);
  assert.deepEqual(found("  of   MIND "), [[2, "of mind"]]);
  assert.deepEqual(found(" "), []);
});
