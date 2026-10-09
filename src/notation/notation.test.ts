import test from "node:test";
import assert from "node:assert/strict";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex } from "../glossary/textIndex.ts";
import { parseNotationReply } from "./prompts.ts";
import {
  findSymbolSites,
  isSymbolCandidate,
  laterDefinitionPages,
  meaningAt,
  mergeMeaning,
  needsLookup,
  normalizeSymbol,
  parseSymbolList,
  pickSites,
  symbolKey,
} from "./symbols.ts";

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

test("isSymbolCandidate: notation, not words", () => {
  for (const symbol of ["ψ", "ρA", "H", "x1", "x'", "a_n", "∇", "⟨ψ|", "Tr", "𝜓"]) assert.ok(isSymbolCandidate(symbol), symbol);
  for (const word of ["entanglement", "a state", "is", "of", "an", "Bell state", "operator"]) {
    assert.ok(!isSymbolCandidate(word), word);
  }
});

test("normalizeSymbol folds math letters and markup", () => {
  assert.equal(normalizeSymbol("𝜓"), "ψ");
  assert.equal(normalizeSymbol("x_ 1"), "x1");
  assert.equal(normalizeSymbol("ρ₁"), "ρ1");
  assert.equal(symbolKey("𝜓"), symbolKey("ψ"));
});

// ψ is defined on p. 1, used on p. 2, redefined on p. 3; "n" is a lone letter.
const BOOK = buildTextIndex([
  page(1, [
    ["Let ψ denote the state of the system, and let n be the number of qubits.", 72, 100],
    ["Then ψ evolves in time and n stays fixed.", 72, 115],
  ]),
  page(2, [["We apply a gate to ψ and measure; and an n appears in the count.", 72, 100]]),
  page(3, [["From now on ψ denotes the wave function in position space.", 72, 100]]),
]);

test("symbol sites: every use of ψ, scored; only the defining uses of a lone letter", () => {
  const psi = findSymbolSites(BOOK, "ψ");
  assert.equal(psi.length, 4);
  assert.deepEqual(
    psi.filter((s) => s.score >= 3).map((s) => s.page.pageNumber),
    [1, 3],
  );
  const n = findSymbolSites(BOOK, "n");
  assert.deepEqual(
    n.map((s) => [s.page.pageNumber, s.page.text.slice(s.start - 4, s.end)]),
    [[1, "let n"]],
  );
});

test("pickSites prefers the definition in effect, and shows a later one", () => {
  const psi = findSymbolSites(BOOK, "ψ");
  const onPage2 = pickSites(psi, 2);
  assert.deepEqual(onPage2.map((s) => s.page.pageNumber), [1, 3]);
  assert.deepEqual(laterDefinitionPages(psi, 2), [3]);
  assert.deepEqual(laterDefinitionPages(psi, 3), []);
});

test("meanings by page: in effect, defined later, reused or looked up again", () => {
  const psi = findSymbolSites(BOOK, "ψ");
  let meanings = mergeMeaning(undefined, { fromPage: 1, definition: "The system's state.", source: "defined" });
  assert.equal(meaningAt(meanings, 2)!.meaning.definition, "The system's state.");
  assert.equal(needsLookup(meanings, psi, 2), false); // nothing new between p. 1 and p. 2
  assert.equal(needsLookup(meanings, psi, 3), true); // redefined on p. 3
  meanings = mergeMeaning(meanings, { fromPage: 3, definition: "The wave function.", source: "defined" });
  assert.equal(meaningAt(meanings, 3)!.meaning.definition, "The wave function.");
  assert.equal(meaningAt(meanings, 2)!.meaning.definition, "The system's state.");
  const later = mergeMeaning(undefined, { fromPage: 5, definition: "x", source: "defined" });
  assert.deepEqual(meaningAt(later, 2)!.definedLater, true);
});

test("the document's own list of symbols", () => {
  const index = buildTextIndex([
    page(1, [
      ["List of Symbols", 72, 60],
      ["ρ", 72, 100],
      [" ", 78, 100], // pdf.js's whitespace run across the gap
      ["density operator", 160, 100],
      [" ", 256, 100],
      ["12", 500, 100],
      ["H", 72, 116],
      ["Hamiltonian of the system", 160, 116],
      ["A sentence that is not an entry at all.", 72, 200],
    ]),
  ]);
  const list = parseSymbolList(index, []);
  assert.deepEqual(
    list.map((e) => [e.symbol, e.meaning]),
    [
      ["ρ", "density operator"],
      ["H", "Hamiltonian of the system"],
    ],
  );
  assert.equal(list[0].key, symbolKey("ρ"));
});

test("parseNotationReply reads the fields, even mid-stream", () => {
  const full = "SOURCE: defined\nSYMBOL: $\\rho_A$\nThe reduced state of subsystem $A$.\n---\nDEFINED_IN: S2";
  assert.deepEqual(parseNotationReply(full), {
    source: "defined",
    symbolLatex: "$\\rho_A$",
    definition: "The reduced state of subsystem $A$.",
    definedIn: "S2",
  });
  assert.equal(parseNotationReply("SOURCE: defined\nSYMB").definition, "");
  assert.equal(parseNotationReply("SOURCE: inferred\nSYMBOL: $x$\nThe position\n--").definition, "The position");
});
