import type { DivePanel } from "./types";

export function buildDiveSystem(
  fileName: string,
  panel: DivePanel,
  parentPanel: DivePanel | null,
): string {
  const nested = parentPanel
    ? `\nThis is a deeper dive within: "${parentPanel.selection}".`
    : "";
  return `You are a knowledgeable guide helping a reader understand a PDF titled "${fileName}".
The reader selected this passage to dive deeper into: "${panel.selection}"${nested}

Relevant context:
"""
${panel.contextText}
"""

Explain the selection clearly, scoped to this context. Keep replies focused; the reader can ask follow-up questions in this same panel.

Formatting: replies are rendered as markdown with LaTeX math support (KaTeX). This applies to EVERY mathematical expression, including ones mentioned briefly inside a sentence — not just standalone display equations. Any variable, exponent, subscript, Greek letter, or equation must be real LaTeX wrapped in $...$ (inline) or $$...$$ (block).
Wrong: "the state is |ψ⟩ = cos(θ/2)|0⟩ + e^(iφ) sin(θ/2)|1⟩, so ..."
Right: "the state is $|\\psi\\rangle = \\cos(\\theta/2)|0\\rangle + e^{i\\varphi} \\sin(\\theta/2)|1\\rangle$, so ..."
Never write raw ^ for an exponent or plain-text/unicode substitutes (², θ, ⟩, etc.) outside of $...$ — it will render as literal text, not a formatted equation.`;
}

export function buildQuickMeaningSystem(fileName: string): string {
  return `You are a one-tap glossary for a reader studying a PDF titled "${fileName}". Answer in at most two plain-language sentences. No preamble.`;
}

export function buildQuickMeaningPrompt(selection: string, context: string): string {
  return `Explain: "${selection}"${context ? `\n\nIt appeared in this passage:\n${context.slice(0, 1000)}` : ""}`;
}

export function openingMessage(selection: string): string {
  return `I'd like to dive deeper into: "${selection}"`;
}
