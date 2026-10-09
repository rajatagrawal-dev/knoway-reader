import test from "node:test";
import assert from "node:assert/strict";
import { markersToPages } from "../grounding/citations.ts";
import { GROUNDING_RULES, MATH_RULES, renderSources } from "../grounding/prompt.ts";
import type { SourceRef } from "../grounding/types.ts";
import { splitDiagram } from "./diagram.ts";
import { DEFAULT_EXPERIMENTS, EXPERIMENT_GROUPS, parseExperiments } from "./experiments.ts";
import { buildDivePrompt, buildDiveSystem } from "./prompts.ts";
import { readerNotesBlock } from "./readerNotes.ts";
import { hideSuggestionBlock, mergeSuggestions, splitSuggestions, suggestedDiveSources } from "./suggestions.ts";
import { buildTreeSummaryRequest, treeAnswerCount } from "./summary.ts";
import { historyTurns, treeOf } from "./tree.ts";
import type { DivePanel, DiveTurn } from "./types.ts";

const pageLabel = (n: number) => String(n);

function source(label: string, pageNumber: number, text: string, extra: Partial<SourceRef> = {}): SourceRef {
  // One passage per page in these fixtures, so the page names its chunk.
  return { label, pageNumber, start: 0, end: text.length, text, chunkId: `p${pageNumber}-0`, ...extra };
}

function panel(id: string, parentId: string | null, selection: string, turns: DiveTurn[] = [], extra: Partial<DivePanel> = {}): DivePanel {
  return {
    id,
    parentId,
    anchorHighlightId: parentId ? null : `h-${id}`,
    selection,
    label: selection.slice(0, 60),
    contextText: "Earlier answer text [S1].",
    turns,
    createdAt: `2026-09-30T00:00:0${id.length}Z`,
    ...extra,
  };
}

const turn = (role: DiveTurn["role"], content: string, sources?: SourceRef[]): DiveTurn => ({ role, content, at: "", ...(sources ? { sources } : {}) });

// ---- Experiments ------------------------------------------------------------------

test("every experiment is off by default, and saved settings only set known flags", () => {
  assert.ok(Object.values(DEFAULT_EXPERIMENTS).every((on) => on === false));
  assert.deepEqual(parseExperiments(null), DEFAULT_EXPERIMENTS);
  assert.deepEqual(parseExperiments("not json"), DEFAULT_EXPERIMENTS);
  const parsed = parseExperiments(JSON.stringify({ suggestions: true, removedFlag: true, localWindow: "yes" }));
  assert.equal(parsed.suggestions, true);
  assert.equal(parsed.localWindow, false);
  assert.equal("removedFlag" in parsed, false);
});

test("the settings menu lists every experiment exactly once", () => {
  const listed = EXPERIMENT_GROUPS.flatMap((group) => group.items.map((item) => item.key)).sort();
  assert.deepEqual(listed, Object.keys(DEFAULT_EXPERIMENTS).sort());
});

// ---- Prompts ------------------------------------------------------------------------

// The grounded dive prompt as it was before the experiments, verbatim.
function originalDiveSystem(
  fileName: string,
  p: DivePanel,
  parentPanel: DivePanel | null,
  grounding: { sources: SourceRef[]; pageLabel: (n: number) => string; attachmentNote?: string },
): string {
  const selection = p.selectionImage
    ? p.selection
      ? `this passage: "${p.selection}" (see the attached image of the selected region)`
      : "the region of the page shown in the attached image"
    : `this passage: "${p.selection}"`;
  const earlier = parentPanel
    ? `\nIt comes from an earlier explanation of "${parentPanel.selection}" (context only — not a source, don't cite it):\n"""\n${markersToPages(p.contextText, [], grounding.pageLabel)}\n"""\n`
    : "";
  return `You help a reader understand a PDF titled "${fileName}". They selected ${selection} to dive deeper into.
${earlier}
Sources from the document:
${renderSources(grounding.sources, grounding.pageLabel)}

${GROUNDING_RULES}
- Explain the selection in terms of the sources. For a derivation or proof, use short numbered steps.

${MATH_RULES}${grounding.attachmentNote ? `\n\n${grounding.attachmentNote}` : ""}`;
}

test("with no experiments the dive prompt is exactly the original one", () => {
  const sources = [source("S1", 3, "Entanglement links two qubits."), source("S2", 5, "A Bell state is maximally entangled.")];
  const root = panel("r", null, "Entanglement links two qubits");
  const nested = panel("n", "r", "maximally entangled");
  for (const [p, parent] of [[root, null], [nested, root]] as const) {
    for (const attachmentNote of [undefined, "The reader attached S2."]) {
      const grounding = { sources, pageLabel, attachmentNote };
      assert.equal(buildDiveSystem("book.pdf", p, parent, grounding), originalDiveSystem("book.pdf", p, parent, grounding));
      assert.equal(buildDiveSystem("book.pdf", p, parent, grounding, {}), originalDiveSystem("book.pdf", p, parent, grounding));
    }
  }
});

test("stable sources: the system prompt stays identical across follow-ups; additions go in the suffix", () => {
  const base = [source("S1", 3, "Entanglement links two qubits."), source("S2", 5, "A Bell state.")];
  const p = panel("r", null, "Entanglement");
  const first = buildDivePrompt("book.pdf", p, null, { sources: base, pageLabel }, { splitAt: 2, suggestions: true });
  const followUp = buildDivePrompt(
    "book.pdf",
    p,
    null,
    { sources: [...base, source("S3", 9, "Teleportation uses a Bell pair.")], pageLabel, attachmentNote: "Note." },
    { splitAt: 2, suggestions: true },
  );
  const diagram = buildDivePrompt("book.pdf", p, null, { sources: base, pageLabel }, { splitAt: 2, suggestions: true, diagram: true });
  assert.equal(followUp.system, first.system);
  assert.equal(diagram.system, first.system);
  assert.equal(first.suffix, "");
  assert.match(followUp.suffix, /More sources for this question:\n<source id="S3"/);
  assert.match(followUp.suffix, /Note\.$/);
  assert.match(diagram.suffix, /mermaid/);
  assert.match(first.system, /isn't listed in this prompt/);
});

test("orientation-first, suggestions, root anchor and reader notes each add their part", () => {
  const sources = [source("S1", 3, "Entanglement links two qubits.")];
  const root = panel("r", null, "Entanglement links two qubits");
  const nested = panel("n", "r", "qubits");
  const system = buildDiveSystem("book.pdf", nested, root, { sources, pageLabel }, {
    orientationFirst: true,
    suggestions: true,
    root: { selection: root.selection, page: "3", firstAnswer: "It says entanglement correlates outcomes." },
    readerNotes: "What the reader has noted: …",
  });
  assert.match(system, /this is the dive's first answer/);
  assert.match(system, /never refuse/);
  assert.doesNotMatch(system, /\[not-covered\]/);
  assert.match(system, /<next>/);
  assert.match(system, /branched from a reader's question about this passage \(p\. 3\)/);
  assert.match(system, /connecting this back to the passage/);
  assert.match(system, /What the reader has noted/);
  // A root dive gets no anchor, even when one is passed.
  const rootSystem = buildDiveSystem("book.pdf", root, null, { sources, pageLabel }, { root: { selection: "x" } });
  assert.doesNotMatch(rootSystem, /branched from/);
});

// ---- Suggestions ------------------------------------------------------------------

test("splitSuggestions reads the <next> block and returns the answer without it", () => {
  const text = `Entanglement correlates outcomes [S1].

<next>
ask: Why can't this be classical?
- dive: Bell state [S2]
dive: density matrix [inferred: S3]
diagram: how the correlation arises
nonsense line
</next>`;
  const { body, suggestions } = splitSuggestions(text);
  assert.equal(body, "Entanglement correlates outcomes [S1].");
  assert.deepEqual(suggestions, [
    { kind: "ask", text: "Why can't this be classical?" },
    { kind: "dive", text: "Bell state", sourceLabel: "S2" },
    { kind: "dive", text: "density matrix", sourceLabel: "S3" },
    { kind: "diagram", text: "how the correlation arises" },
  ]);
  // Cut off before the closing tag: still read.
  assert.equal(splitSuggestions("Answer.\n<next>\nask: What next?").suggestions.length, 1);
  assert.deepEqual(splitSuggestions("No block here."), { body: "No block here.", suggestions: [] });
});

test("hideSuggestionBlock hides the block and a half-arrived tag while streaming", () => {
  assert.equal(hideSuggestionBlock("Answer.\n<next>\nask: x"), "Answer.\n");
  assert.equal(hideSuggestionBlock("Answer.\n<ne"), "Answer.\n");
  assert.equal(hideSuggestionBlock("a < b"), "a < b");
});

test("mergeSuggestions adds up to two topics the selection names, without repeats", () => {
  const sources = [
    source("S1", 1, "Theorem 3.1. …", { via: "xref", is: "Theorem 3.1" }),
    source("S2", 2, "We write ρ …", { via: "symbol", is: "definition of ρ" }),
    source("S3", 2, "…", { via: "term", is: 'definition of "Bell state"' }),
    source("S4", 4, "local", { via: "local" }),
  ];
  const merged = mergeSuggestions([{ kind: "dive", text: "Theorem 3.1" }], sources);
  assert.deepEqual(
    merged.map((s) => [s.text, s.fromContext ?? false]),
    [
      ["Theorem 3.1", false],
      ["ρ", true],
      ["Bell state", true],
    ],
  );
});

test("a suggested dive inherits the passage it cited, then what its answer cited", () => {
  const sources = [source("S1", 1, "one"), source("S2", 2, "two"), source("S3", 3, "three")];
  const answer = turn("assistant", "Claim [S1]. Another [S3].", sources);
  assert.deepEqual(suggestedDiveSources(answer, "S2")?.map((s) => s.label), ["S2", "S1", "S3"]);
  assert.deepEqual(suggestedDiveSources(answer, undefined)?.map((s) => s.label), ["S1", "S3"]);
});

// ---- Diagrams ------------------------------------------------------------------

test("splitDiagram takes the mermaid block out of the answer's text", () => {
  const done = splitDiagram('Before.\n\n```mermaid\nflowchart TD\n  A["x"] --> B["y"]\n```\n\nHow to read it [S1].');
  assert.equal(done.code, 'flowchart TD\n  A["x"] --> B["y"]');
  assert.equal(done.text, "Before.\n\nHow to read it [S1].");
  const streaming = splitDiagram("Intro.\n```mermaid\nflowchart TD\n  A");
  assert.deepEqual(streaming, { code: null, pending: true, text: "Intro." });
  assert.deepEqual(splitDiagram("Plain."), { code: null, pending: false, text: "Plain." });
});

// ---- History ------------------------------------------------------------------------

test("historyTurns keeps the last two exchanges, plus the opening one when asked", () => {
  const turns = Array.from({ length: 9 }, (_, i) => turn(i % 2 === 0 ? "user" : "assistant", `t${i}`));
  assert.deepEqual(historyTurns(turns, 4, false).map((t) => t.content), ["t4", "t5", "t6", "t7", "t8"]);
  assert.deepEqual(historyTurns(turns, 4, true).map((t) => t.content), ["t0", "t1", "t4", "t5", "t6", "t7", "t8"]);
  // Short dives are sent whole either way, with nothing doubled.
  const short = turns.slice(0, 5);
  assert.deepEqual(historyTurns(short, 4, true).map((t) => t.content), ["t0", "t1", "t2", "t3", "t4"]);
  // Always starts on the reader's turn.
  assert.equal(historyTurns(turns.slice(0, 7), 4, true)[0].role, "user");
});

// ---- Reader notes ------------------------------------------------------------------

test("reader notes: glossary terms in play, nearby comments and dives; empty when there's nothing", () => {
  const block = readerNotesBlock({
    selection: "The Bell state is entangled",
    sources: [],
    pageNumber: 10,
    glossary: [
      { term: "Bell state", aliases: [], definition: "A maximally entangled two-qubit state.", source: "defined" },
      { term: "qutrit", aliases: [], definition: "A three-level system." },
    ],
    highlights: [
      { pageNumber: 11, text: "Bell basis", comment: "Compare with the computational basis" },
      { pageNumber: 40, text: "far away", comment: "Not near" },
      { pageNumber: 10, text: "no comment", comment: "" },
    ],
    dives: [
      { label: "Teleportation protocol", pageNumber: 12, summary: "Uses one Bell pair." },
      { label: "Far dive", pageNumber: 90 },
    ],
    pageLabel,
  });
  assert.match(block, /Bell state: A maximally entangled two-qubit state\. \(as the document defines it\)/);
  assert.doesNotMatch(block, /qutrit/);
  assert.match(block, /Their note on p\. 11 \("Bell basis"\): Compare/);
  assert.doesNotMatch(block, /Not near|no comment/);
  assert.match(block, /They explored "Teleportation protocol" \(p\. 12\): Uses one Bell pair\./);
  assert.doesNotMatch(block, /Far dive/);
  assert.match(block, /never cite them/);
  assert.equal(
    readerNotesBlock({ selection: "x", sources: [], pageNumber: 1, glossary: [], highlights: [], dives: [], pageLabel }),
    "",
  );
});

// ---- Tree summary ------------------------------------------------------------------

function diveTree(): DivePanel[] {
  const rootSources = [source("S1", 3, "Entanglement links two qubits."), source("S2", 5, "A Bell state is maximally entangled.")];
  const childSources = [source("S1", 5, "A Bell state is maximally entangled."), source("S2", 8, "Measurement collapses the pair.")];
  return [
    panel("r", null, "Entanglement links two qubits", [
      turn("user", 'I\'d like to dive deeper into: "Entanglement links two qubits"'),
      turn("assistant", "It correlates outcomes [S1], as in a Bell state [S2].", rootSources),
      turn("user", "Why is it not classical?"),
      turn("assistant", "⚠️ Dive reply failed."),
    ]),
    panel("nn", "r", "Bell state", [
      turn("user", 'I\'d like to dive deeper into: "Bell state"'),
      turn("assistant", "Maximally entangled [S1]; measuring one collapses both [inferred: S2].", childSources),
    ]),
  ].map((p, i) => ({ ...p, pageNumber: i === 0 ? 3 : undefined }));
}

test("treeOf walks the tree depth-first with depths", () => {
  assert.deepEqual(
    treeOf(diveTree(), "r").map(({ panel: p, depth }) => [p.id, depth]),
    [
      ["r", 0],
      ["nn", 1],
    ],
  );
});

test("the tree summary renumbers every answer's citations into one shared list", () => {
  const panels = diveTree();
  const { system, prompt, sources } = buildTreeSummaryRequest({ fileName: "book.pdf", panels, rootId: "r", pageLabel });
  // Three distinct passages cited across the tree (the Bell state one twice).
  assert.deepEqual(sources.map((s) => `${s.label}:p${s.pageNumber}`), ["S1:p3", "S2:p5", "S3:p8"]);
  assert.match(prompt, /It correlates outcomes \[S1\], as in a Bell state \[S2\]\./);
  // The child's own S1/S2 became the shared S2/S3.
  assert.match(prompt, /Maximally entangled \[S2\]; measuring one collapses both \[inferred: S3\]\./);
  // The canned opening and failed replies are left out; real questions stay.
  assert.doesNotMatch(prompt, /I'd like to dive deeper|⚠️/);
  assert.match(prompt, /Reader: Why is it not classical\?/);
  assert.match(system, /Entanglement links two qubits/);
  assert.match(system, /<source id="S3" p="8">/);
  assert.equal(treeAnswerCount(panels, "r"), 2);
});
