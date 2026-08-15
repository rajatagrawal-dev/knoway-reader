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

Explain the selection clearly, scoped to this context. Keep replies focused; the reader can ask follow-up questions in this same panel.`;
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
