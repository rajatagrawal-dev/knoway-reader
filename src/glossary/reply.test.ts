import test from "node:test";
import assert from "node:assert/strict";
import { parseGlossaryReply } from "./reply.ts";

test("parses a complete reply", () => {
  const reply = `SOURCE: defined
A two-level quantum system, the basic unit of quantum information; its state is $\\alpha|0\\rangle + \\beta|1\\rangle$.
---
DEFINED_IN: S2
ALIASES: quantum bit; "qbit"`;
  assert.deepEqual(parseGlossaryReply(reply), {
    source: "defined",
    definition:
      "A two-level quantum system, the basic unit of quantum information; its state is $\\alpha|0\\rangle + \\beta|1\\rangle$.",
    definedIn: "S2",
    aliases: ["quantum bit", "qbit"],
  });
});

test("shows nothing while only the SOURCE label has streamed", () => {
  assert.deepEqual(parseGlossaryReply("SOU"), { definition: "", aliases: [] });
  assert.equal(parseGlossaryReply("SOURCE: inf").definition, "");
});

test("shows the definition as it streams, hiding a half-arrived separator", () => {
  assert.equal(parseGlossaryReply("SOURCE: inferred\nThe basic unit").definition, "The basic unit");
  assert.equal(parseGlossaryReply("SOURCE: inferred\nThe basic unit.\n--").definition, "The basic unit.");
  assert.equal(parseGlossaryReply("SOURCE: inferred\nThe basic unit.\n---\nDEFINED_IN: no").definition, "The basic unit.");
});

test("treats 'none' trailer values as absent", () => {
  const parsed = parseGlossaryReply("SOURCE: general\nA meaning.\n---\nDEFINED_IN: none\nALIASES: none");
  assert.equal(parsed.definedIn, undefined);
  assert.deepEqual(parsed.aliases, []);
});

test("tolerates a missing SOURCE line or separator", () => {
  assert.deepEqual(parseGlossaryReply("Just a definition.\nDEFINED_IN: S1"), {
    source: undefined,
    definition: "Just a definition.",
    definedIn: "S1",
    aliases: [],
  });
});

test("ignores an unknown SOURCE value", () => {
  const parsed = parseGlossaryReply("SOURCE: maybe\nA meaning.");
  assert.equal(parsed.source, undefined);
  assert.equal(parsed.definition, "A meaning.");
});
