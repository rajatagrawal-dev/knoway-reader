import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex } from "../glossary/textIndex.ts";
import { collectTargets, findPageRefs, findPageTargets, parseBibliography, sentenceAround, trimPartialWords } from "./detect.ts";

// Pages laid out like a real paper: runs of text at (left, top), 6 units per
// character, 12 tall, on a 600×800 page.
type Run = [text: string, left: number, top: number];

function page(pageNumber: number, runs: Run[]): PdfExtractedPage {
  return {
    pageNumber,
    width: 600,
    height: 800,
    textItems: runs.map(([text, left, top], index) => ({
      text,
      index,
      pageNumber,
      rect: { left, top, width: text.length * 6, height: 12, pageNumber },
    })),
  };
}

const PAPER = [
  page(1, [
    ["Theorem 4.1. Every bounded sequence has a convergent subsequence.", 72, 100],
    ["The proof is short and uses compactness.", 72, 115],
    ["By Theorem 4.1 and Eq. (3.2), and by (3.2) too, but not Lemma 9.9, see", 72, 170],
    ["Figure 3 for the plot, [2] and [1, 2], and Section 3.2 as well as (Smith et al., 2020).", 72, 185],
    ["x = y + z", 250, 230],
    ["(3.2)", 520, 230],
    ["Some text above the figure.", 72, 300],
    ["Figure 3: A plot of the sequence.", 72, 500],
  ]),
  page(2, [
    ["References", 72, 100],
    ["[1] A. Author, The first title, 2019.", 72, 125],
    ["[2] B. Writer, The second title, 2021.", 72, 140],
  ]),
];

const SECTIONS = [
  { title: "3 Results", depth: 0, pageNumber: 1 },
  { title: "3.2 Bell states", depth: 1, pageNumber: 1 },
  { title: "References", depth: 0, pageNumber: 2 },
];

test("targets: theorem headings, equation numbers and captions, but not mentions", () => {
  const index = buildTextIndex(PAPER);
  const targets = findPageTargets(index.pages[0]);
  assert.deepEqual(
    targets.map((t) => t.key).sort(),
    ["equation:3.2", "figure:3", "theorem:4.1"],
  );
  const figure = targets.find((t) => t.key === "figure:3")!;
  // The figure is above its caption: the preview starts at the text above it.
  assert.ok(figure.top < 500 / 800 && figure.top >= 312 / 800 - 0.001, String(figure.top));
  const equation = targets.find((t) => t.key === "equation:3.2")!;
  assert.ok(equation.top < 230 / 800 && equation.bottom > 242 / 800);
  const theorem = targets.find((t) => t.key === "theorem:4.1")!;
  assert.ok(theorem.bottom > 127 / 800, "takes in the theorem's following line");
});

test("references resolve to their targets; unresolved and self-references aren't marked", () => {
  const index = buildTextIndex(PAPER);
  const targets = collectTargets(index.pages, SECTIONS);
  const refs = findPageRefs(index.pages[0], targets);
  assert.deepEqual(
    refs.map((r) => [r.text, r.targets.map((t) => t.key)]),
    [
      ["Theorem 4.1", ["theorem:4.1"]],
      ["Eq. (3.2)", ["equation:3.2"]],
      ["(3.2)", ["equation:3.2"]],
      ["Figure 3", ["figure:3"]],
      ["[2]", ["citation:2"]],
      ["[1, 2]", ["citation:1", "citation:2"]],
      ["Section 3.2", ["section:3.2"]],
    ],
  );
  const citation = refs.find((r) => r.text === "[2]")!.targets[0];
  assert.match(citation.entryText!, /^\[2\] B\. Writer, The second title, 2021\.$/);
  assert.equal(citation.pageNumber, 2);
});

test("lowercase references count too", () => {
  const index = buildTextIndex([
    page(1, [
      ["as shown in eq. (3.2) and fig. 3, and in section 3.2.", 72, 100],
      ["x = y", 250, 150],
      ["(3.2)", 520, 150],
      ["Figure 3. Caption.", 72, 400],
    ]),
  ]);
  const targets = collectTargets(index.pages, [{ title: "3.2 Things", depth: 1, pageNumber: 1 }]);
  assert.deepEqual(
    findPageRefs(index.pages[0], targets).map((r) => r.text),
    ["eq. (3.2)", "fig. 3", "section 3.2"],
  );
});

test("author–year bibliographies and citations", () => {
  const index = buildTextIndex([
    page(1, [["As argued (Smith et al., 2020) and by Doe (2019), but not (Nobody, 1999).", 72, 100]]),
    page(2, [
      ["Bibliography", 72, 100],
      ["Doe, K. (2019). Another result. Journal of Things.", 72, 125],
      ["Smith, J., Lee, M. and Chan, P. (2020). Quantum things.", 72, 140],
      ["Physical Review 12.", 90, 155],
    ]),
  ]);
  const entries = parseBibliography(index.pages, []);
  assert.equal(entries.length, 2);
  assert.match(entries[1].text, /^Smith, J\..*Physical Review 12\.$/);
  const refs = findPageRefs(index.pages[0], collectTargets(index.pages, []));
  assert.deepEqual(
    refs.map((r) => [r.text, r.targets[0].entryText?.slice(0, 8)]),
    [
      ["(Smith et al., 2020)", "Smith, J"],
      ["Doe (2019)", "Doe, K. "],
    ],
  );
});

test("no bibliography, no citation marks", () => {
  const index = buildTextIndex([page(1, [["A claim [3] with nothing to cite.", 72, 100]])]);
  assert.deepEqual(findPageRefs(index.pages[0], collectTargets(index.pages, [])), []);
});

test("a link's text loses stray letters of neighboring words", () => {
  const text = "See the key bound for details.";
  const cut = (range: [number, number]) => text.slice(...trimPartialWords(text, range));
  assert.equal(cut([4, 19]), "the key bound"); // "the key bound f"
  assert.equal(cut([3, 17]), "the key bound"); // " the key bound"
  assert.equal(cut([5, 17]), "key bound"); // "he" is a two-letter fragment: dropped
  assert.equal(cut([3, 15]), "the key bou"); // "bou" is three letters: kept
  assert.equal(cut([4, 17]), "the key bound");
});

test("sentenceAround finds the sentence a reference is in", () => {
  const text = "First sentence. By Theorem 2.1 the bound holds. Last one.";
  const at = text.indexOf("Theorem 2.1");
  const [s, e] = sentenceAround(text, at, at + 11);
  assert.equal(text.slice(s, e), "By Theorem 2.1 the bound holds.");
});
