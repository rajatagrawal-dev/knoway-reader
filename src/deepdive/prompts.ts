import { markersToPages } from "../grounding/citations.ts";
import { GROUNDING_RULES, MATH_RULES, renderSources } from "../grounding/prompt.ts";
import type { SourceRef } from "../grounding/types.ts";
import type { DivePanel } from "./types.ts";

// What the Deep Dive experiments (experiments.ts) change about a dive's
// prompt. Every field is optional, and with none set the prompt is exactly
// the original one.
export interface DivePromptOptions {
  orientationFirst?: boolean; // dive-specific answering rules: orient first, explain on follow-ups
  suggestions?: boolean; // ask for suggested next steps (suggestions.ts parses them)
  diagrams?: boolean; // suggestions may include a diagram
  diagram?: boolean; // this request asks for a diagram
  // rootAnchor, nested dives: the passage the tree started from, and the
  // first answer about it.
  root?: { selection: string; page?: string; firstAnswer?: string };
  readerNotes?: string; // readerNotes.ts's block
  // stableSources: sources from this index on are this question's
  // additions, sent after the stable prefix (see DivePrompt).
  splitAt?: number;
}

// The system prompt, split for prompt caching: `system` stays byte-identical
// across a dive's follow-ups; `suffix` holds what changes per question.
// Without stable sources the suffix is empty.
export interface DivePrompt {
  system: string;
  suffix: string;
}

const ORIENT_AND_EXPLAIN = (citeScope: string) => `How to answer:
- If the conversation has no earlier answer from you, this is the dive's first answer. Orient the reader; it's short on purpose, since you don't yet know what they want to dig into. In 60–130 words: what the passage says, in plain words (don't restate it); what leads up to it in the document; and what role it plays in the argument. No derivations yet. If their first message asks a question of its own, answer that question instead.
- Later answers explain. Open with the core idea in a plain sentence or two, then build it up in small steps, numbered for a derivation or proof. Fill in what the text skips (a missing step, the intuition, background it assumes). About 250 words unless the reader asks for more. No preamble, no recap, don't restate the question.
- Explain with the document's own definitions, equations and examples first; bring in outside knowledge only for what the sources don't cover.
- After each claim taken from a source, cite it by id: [S2] (several: [S2][S5]). For something you reasoned from the sources rather than read there: [inferred: S2]. For anything from outside the sources: [general].
- Quote the document only word for word, in quotation marks, followed by its citation — prose only; never quote a formula (write it in LaTeX instead).
- Never cite an id that isn't listed ${citeScope}.
- If the sources don't explain something, explain it from general knowledge and mark it [general] — never refuse.`;

const SUGGESTION_RULES = (diagrams: boolean) => `After your answer, suggest where the reader could go next, exactly in this form (it's shown as buttons, not as text):
<next>
ask: a follow-up question about this passage, as the reader would ask it (under 12 words)
dive: a concept, term, symbol, equation or result your answer relies on, as a short name (1–5 words) [S2]
</next>
- Two to four lines, mixing ask and dive. On a dive line, cite the source where the document states or defines it, if one does.
- Prefer what the document itself explains, and what matters for understanding the passage. Nothing this dive already covered.${
  diagrams
    ? "\n- When the idea has a structure a small diagram would make clearer (a chain of steps, what depends on what, a process), add a line \"diagram: what it would show\"."
    : ""
}`;

export const DIAGRAM_RULES = `This time, answer with a diagram: a Mermaid flowchart in a \`\`\`mermaid code block, then one or two sentences on how to read it, with citations.
- "flowchart TD" or "flowchart LR"; at most 12 nodes.
- Write every node as id["label"]: a short plain-words label, no LaTeX, no $, no double quotes inside it.
- Label an edge with the relation where it helps: A -->|implies| B.
- Only steps and concepts from this dive and its sources.`;

const ROOT_ANCHOR = (root: NonNullable<DivePromptOptions["root"]>) =>
  `\nThis dive branched from a reader's question about this passage${root.page ? ` (p. ${root.page})` : ""} — the passage they are ultimately trying to understand:
"""
${root.selection}
"""${root.firstAnswer ? `\nThe first explanation of it said:\n"""\n${root.firstAnswer}\n"""` : ""}
`;

// A dive grounded in the document: the passages it may cite, the shared
// answering rules (short, cited — see grounding/prompt.ts), and math
// formatting. Without sources (the document's text couldn't be read), the
// older unlabeled-context prompt below is used instead.
export function buildDiveSystem(
  fileName: string,
  panel: DivePanel,
  parentPanel: DivePanel | null,
  grounding?: {
    sources: SourceRef[];
    pageLabel: (pageNumber: number) => string;
    attachmentNote?: string; // what the reader added to this question (grounding/attachments.ts)
  },
  options: DivePromptOptions = {},
): string {
  const { system, suffix } = buildDivePrompt(fileName, panel, parentPanel, grounding, options);
  return suffix ? `${system}\n\n${suffix}` : system;
}

export function buildDivePrompt(
  fileName: string,
  panel: DivePanel,
  parentPanel: DivePanel | null,
  grounding?: {
    sources: SourceRef[];
    pageLabel: (pageNumber: number) => string;
    attachmentNote?: string;
  },
  options: DivePromptOptions = {},
): DivePrompt {
  if (!grounding || grounding.sources.length === 0) {
    return { system: buildUngroundedDiveSystem(fileName, panel, parentPanel), suffix: "" };
  }
  const selection = panel.selectionImage
    ? panel.selection
      ? `this passage: "${panel.selection}" (see the attached image of the selected region)`
      : "the region of the page shown in the attached image"
    : `this passage: "${panel.selection}"`;
  // A nested dive's selection comes from an earlier answer, not the
  // document: context for the model, but nothing to cite. Its citation
  // markers (if it's raw answer text) meant other ids, so they go.
  const earlier = parentPanel
    ? `\nIt comes from an earlier explanation of "${parentPanel.selection}" (context only — not a source, don't cite it):\n"""\n${markersToPages(panel.contextText, [], grounding.pageLabel)}\n"""\n`
    : "";
  const root = parentPanel && options.root ? ROOT_ANCHOR(options.root) : "";
  const split = options.splitAt !== undefined && options.splitAt < grounding.sources.length;
  const base = split ? grounding.sources.slice(0, options.splitAt) : grounding.sources;
  const added = split ? grounding.sources.slice(options.splitAt) : [];
  const citeScope = options.splitAt !== undefined ? "in this prompt" : "above";
  const rules = options.orientationFirst
    ? ORIENT_AND_EXPLAIN(citeScope)
    : `${citeScope === "above" ? GROUNDING_RULES : GROUNDING_RULES.replace("isn't listed above", "isn't listed in this prompt")}
- Explain the selection in terms of the sources. For a derivation or proof, use short numbered steps.`;
  const tieBack = root ? "\n- End with one sentence connecting this back to the passage the dive branched from." : "";
  const notes = options.readerNotes ? `\n\n${options.readerNotes}` : "";
  // Stays in the prompt on a diagram request too, so the stable prefix
  // doesn't change; the diagram rules say to skip it.
  const suggestions = options.suggestions ? `\n\n${SUGGESTION_RULES(Boolean(options.diagrams))}` : "";

  const perQuestion = [
    added.length ? `More sources for this question:\n${renderSources(added, grounding.pageLabel)}` : "",
    options.diagram ? `${DIAGRAM_RULES}${options.suggestions ? "\n- No <next> block this time." : ""}` : "",
    grounding.attachmentNote ?? "",
  ].filter(Boolean);
  // Without stable sources everything is one prompt, in the original order.
  if (options.splitAt === undefined) {
    const tail = perQuestion.length ? `\n\n${perQuestion.join("\n\n")}` : "";
    return {
      system: `You help a reader understand a PDF titled "${fileName}". They selected ${selection} to dive deeper into.
${earlier}${root}
Sources from the document:
${renderSources(base, grounding.pageLabel)}${notes}

${rules}${tieBack}

${MATH_RULES}${suggestions}${tail}`,
      suffix: "",
    };
  }
  return {
    system: `You help a reader understand a PDF titled "${fileName}". They selected ${selection} to dive deeper into.
${earlier}${root}
Sources from the document:
${renderSources(base, grounding.pageLabel)}${notes}

${rules}${tieBack}

${MATH_RULES}${suggestions}`,
    suffix: perQuestion.join("\n\n"),
  };
}

function buildUngroundedDiveSystem(
  fileName: string,
  panel: DivePanel,
  parentPanel: DivePanel | null,
): string {
  const nested = parentPanel
    ? `\nThis is a deeper dive within: "${parentPanel.selection}".`
    : "";
  const selectionDescription = panel.selectionImage
    ? panel.selection
      ? `this passage: "${panel.selection}" (see the attached image of the selected region)`
      : "the region of the page shown in the attached image"
    : `this passage: "${panel.selection}"`;
  return `You are a knowledgeable guide helping a reader understand a PDF titled "${fileName}".
The reader selected ${selectionDescription} to dive deeper into.${nested}

Relevant context:
"""
${panel.contextText}
"""

Explain the selection clearly, scoped to this context. Keep replies focused; the reader can ask follow-up questions in this same panel.

Shape the reply for someone trying to understand, not to be impressed:
- Open with the core idea in one or two plain sentences, before any derivation.
- Then build it up in small steps. Keep paragraphs to two or three sentences; one idea per paragraph.
- For a derivation or proof, use a short numbered list or brief bold lead-ins ("**Set up.**", "**Trace out the environment.**") so each step is easy to find again.
- End with a single sentence on why it matters or what to take away. No summary of the summary, no offers of further help.
- Skip preamble ("Great question", "This exercise asks…") and don't restate the selection.

Formatting: replies are rendered as markdown with LaTeX math support (KaTeX). This applies to EVERY mathematical expression, including ones mentioned briefly inside a sentence — not just standalone display equations. Any variable, exponent, subscript, Greek letter, or equation must be real LaTeX wrapped in $...$ (inline) or $$...$$ (block). Never write raw ^ for an exponent or plain-text/unicode substitutes (², θ, ⟩, etc.) outside of $...$ — it will render as literal text, not a formatted equation.

Keep it uncluttered: don't run a full equation into the middle of a sentence. Anything with an equals sign, multiple terms, a matrix, or that's central to the explanation goes on its own line as a block equation, with $$ on its own line above and below it and a blank line before and after, set off from the surrounding prose. Give each block equation its own block; don't chain several in one line. Save inline math ($...$) for short, incidental mentions — a single variable ($\\alpha$), a bare term ($x^2$) — not for the equation the sentence is actually about. When unsure, break it onto its own line.

Wrong: "the state is |ψ⟩ = cos(θ/2)|0⟩ + e^(iφ) sin(θ/2)|1⟩, so measuring gives outcome 0 with probability cos²(θ/2)."
Right: "the state is:

$$
|\\psi\\rangle = \\cos(\\theta/2)|0\\rangle + e^{i\\varphi} \\sin(\\theta/2)|1\\rangle
$$

Measuring gives outcome 0 with probability $\\cos^2(\\theta/2)$."`;
}

export function buildQuickMeaningSystem(fileName: string): string {
  return `You are a one-tap glossary for a reader studying a PDF titled "${fileName}". Answer in at most two plain-language sentences. No preamble.`;
}

export function buildQuickMeaningPrompt(selection: string, context: string): string {
  return `Explain: "${selection}"${context ? `\n\nIt appeared in this passage:\n${context.slice(0, 1000)}` : ""}`;
}

export function openingMessage(selection: string): string {
  if (!selection) return "I'd like to dive deeper into this selected region (see the attached image).";
  return `I'd like to dive deeper into: "${selection}"`;
}
