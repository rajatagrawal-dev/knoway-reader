// A diagram answer (the diagrams experiment) carries a Mermaid flowchart in
// a ```mermaid block. It's drawn apart from the answer's text — outside the
// turn's markdown, whose characters dive highlights are counted against —
// so the text is the answer without the block.

export interface DiagramSplit {
  code: string | null; // the diagram's source, once its block is complete
  pending: boolean; // a block has opened but not closed yet (still streaming)
  text: string; // the answer without the block
}

const BLOCK = /```mermaid[ \t]*\n([\s\S]*?)\n?```[ \t]*(?:\n|$)/i;
const OPENING = /```mermaid\b/i;

export function splitDiagram(content: string): DiagramSplit {
  const block = BLOCK.exec(content);
  if (block) {
    const text = `${content.slice(0, block.index)}${content.slice(block.index + block[0].length)}`.replace(/\n{3,}/g, "\n\n").trim();
    return { code: block[1].trim(), pending: false, text };
  }
  const open = OPENING.exec(content);
  if (open) return { code: null, pending: true, text: content.slice(0, open.index).trim() };
  return { code: null, pending: false, text: content };
}
