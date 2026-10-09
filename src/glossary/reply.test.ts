import test from "node:test";
import assert from "node:assert/strict";
import { parseGlossaryReply, parseOrigin } from "./reply.ts";

test("parses a complete reply", () => {
  const reply = `SOURCE: defined
ORIGIN: technical; quantum computing
A two-level quantum system, the basic unit of quantum information; its state is $\\alpha|0\\rangle + \\beta|1\\rangle$.
---
DEFINED_IN: S2
ALIASES: quantum bit; "qbit"
LITERAL: none
REFERENCE: W1`;
  assert.deepEqual(parseGlossaryReply(reply), {
    source: "defined",
    origin: { kind: "technical", detail: "quantum computing" },
    definition:
      "A two-level quantum system, the basic unit of quantum information; its state is $\\alpha|0\\rangle + \\beta|1\\rangle$.",
    definedIn: "S2",
    aliases: ["quantum bit", "qbit"],
    literal: undefined,
    reference: "W1",
  });
});

test("parses a foreign phrase's literal meaning and dictionary reference", () => {
  const parsed = parseGlossaryReply(
    `ORIGIN: foreign (Latin)\nSOURCE: inferred\nFormed for one purpose.\n---\nDEFINED_IN: none\nALIASES: none\nLITERAL: “for this”\nREFERENCE: d3.`,
  );
  assert.equal(parsed.source, "inferred");
  assert.deepEqual(parsed.origin, { kind: "foreign", detail: "Latin" });
  assert.equal(parsed.definition, "Formed for one purpose.");
  assert.equal(parsed.literal, "for this");
  assert.equal(parsed.reference, "D3");
});

test("shows nothing while only header labels have streamed", () => {
  assert.equal(parseGlossaryReply("SOU").definition, "");
  assert.equal(parseGlossaryReply("SOURCE: inf").definition, "");
  assert.equal(parseGlossaryReply("SOURCE: inferred\nORI").definition, "");
  assert.equal(parseGlossaryReply("SOURCE: inferred\nORIGIN: tech").definition, "");
  // The header is already usable before the definition starts.
  assert.deepEqual(parseGlossaryReply("SOURCE: inferred\nORIGIN: common; English\n").origin, {
    kind: "common",
    detail: "English",
  });
});

test("shows the definition as it streams, hiding a half-arrived separator", () => {
  const head = "SOURCE: inferred\nORIGIN: common; English\n";
  assert.equal(parseGlossaryReply(`${head}The basic unit`).definition, "The basic unit");
  assert.equal(parseGlossaryReply(`${head}The basic unit.\n--`).definition, "The basic unit.");
  assert.equal(parseGlossaryReply(`${head}The basic unit.\n---\nDEFINED_IN: no`).definition, "The basic unit.");
});

test("treats 'none' trailer values as absent", () => {
  const parsed = parseGlossaryReply(
    "SOURCE: general\nA meaning.\n---\nDEFINED_IN: none\nALIASES: none\nLITERAL: none.\nREFERENCE: none",
  );
  assert.equal(parsed.definedIn, undefined);
  assert.deepEqual(parsed.aliases, []);
  assert.equal(parsed.literal, undefined);
  assert.equal(parsed.reference, undefined);
});

test("tolerates missing header lines or separator (older replies)", () => {
  assert.deepEqual(parseGlossaryReply("Just a definition.\nDEFINED_IN: S1"), {
    source: undefined,
    origin: undefined,
    definition: "Just a definition.",
    definedIn: "S1",
    aliases: [],
    literal: undefined,
    reference: undefined,
  });
});

test("ignores unknown SOURCE and ORIGIN values", () => {
  const parsed = parseGlossaryReply("SOURCE: maybe\nORIGIN: slang; English\nA meaning.");
  assert.equal(parsed.source, undefined);
  assert.equal(parsed.origin, undefined);
  assert.equal(parsed.definition, "A meaning.");
});

test("parseOrigin accepts the separators models use", () => {
  assert.deepEqual(parseOrigin("technical; quantum computing"), { kind: "technical", detail: "quantum computing" });
  assert.deepEqual(parseOrigin("Foreign - German"), { kind: "foreign", detail: "German" });
  assert.deepEqual(parseOrigin("abbreviation"), { kind: "abbreviation" });
  assert.deepEqual(parseOrigin("name; none"), { kind: "name" });
});
