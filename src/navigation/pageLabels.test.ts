import test from "node:test";
import assert from "node:assert/strict";
import { pageNumberForInput } from "../pageLabels.ts";

// Front matter i–iii, then the body numbered from 1.
const LABELS = ["i", "ii", "iii", "1", "2", "3", "4"];

test("a typed label goes to the page printed with it", () => {
  assert.equal(pageNumberForInput(LABELS, "2", 7), 5);
  assert.equal(pageNumberForInput(LABELS, " III ", 7), 3);
});

test("a number no page is labelled with counts from the start of the PDF", () => {
  assert.equal(pageNumberForInput(LABELS, "7", 7), 7);
  assert.equal(pageNumberForInput(null, "3", 7), 3);
});

test("anything else names no page", () => {
  assert.equal(pageNumberForInput(LABELS, "8", 7), null);
  assert.equal(pageNumberForInput(LABELS, "0", 7), null);
  assert.equal(pageNumberForInput(LABELS, "iv", 7), null);
  assert.equal(pageNumberForInput(null, "2.5", 7), null);
  assert.equal(pageNumberForInput(null, "  ", 7), null);
});
