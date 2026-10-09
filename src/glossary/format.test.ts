import test from "node:test";
import assert from "node:assert/strict";
import { originLabel, referenceMarkdown } from "./format.ts";

test("originLabel names where a term comes from", () => {
  assert.equal(originLabel({ kind: "common", detail: "English" }, "ubiquitous"), "Common English word");
  assert.equal(originLabel({ kind: "foreign", detail: "Latin" }, "ad hoc"), "Latin phrase");
  assert.equal(originLabel({ kind: "technical", detail: "quantum computing" }, "qubit"), "Quantum computing term");
  assert.equal(originLabel({ kind: "name", detail: "person" }, "Bell"), "Name · person");
  assert.equal(originLabel({ kind: "abbreviation" }, "EPR"), "Abbreviation");
  assert.equal(originLabel({ kind: "foreign" }, "Zeitgeist"), "Foreign word");
});

test("referenceMarkdown keeps formulas as math and the rest as literal text", () => {
  assert.equal(
    referenceMarkdown("a square matrix $A$ is *similar* to $P^{-1}AP=D$ [1]"),
    "a square matrix $A$ is \\*similar\\* to $P^{-1}AP=D$ \\[1\\]",
  );
  // A literal dollar can't pair up with a formula's delimiter.
  assert.equal(referenceMarkdown("costs US\\$5 for $x_1$"), "costs US&#36;5 for $x_1$");
  assert.equal(referenceMarkdown("1. A list-looking start"), "1\\. A list-looking start");
});
