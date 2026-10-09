import type { GlossarySource } from "../glossary/types.ts";

// A notation lookup: which meaning a symbol has where the reader is. The
// reply is a small line format (like the glossary's) so it can stream and
// any provider can produce it:
//
//   SOURCE: defined
//   SYMBOL: $\rho_A$
//   The reduced density operator of subsystem $A$.
//   ---
//   DEFINED_IN: S2

export interface NotationExcerpt {
  label: string; // "S1"…
  pageLabel: string;
  text: string;
  isReadingPage: boolean; // from the page the reader looked it up on
}

export function buildNotationSystem(fileName: string): string {
  return `You explain mathematical notation to a reader studying a PDF titled "${fileName}". You get a symbol and numbered excerpts from the document where it appears; it may be defined, and redefined later. Say what the symbol means where the reader is reading (the page marked ★): the definition in effect there is the latest one at or before that page.

Reply in exactly this format, with nothing before or after it:
SOURCE: defined | inferred | general
SYMBOL: <the symbol, written in LaTeX inside $...$>
<its meaning: one short sentence, at most 25 words; any math as LaTeX in $...$>
---
DEFINED_IN: <label of the excerpt whose definition is in effect there, e.g. S2, or none>

SOURCE is "defined" if an excerpt defines the symbol, "inferred" if you worked the meaning out from how it's used, and "general" if the excerpts don't reveal it and you give its usual meaning in this field. Start the meaning directly — not "This symbol denotes". The excerpts come from the PDF's extracted text, where formulas are often garbled; read through that. If an image is attached, it shows the symbol as printed.`;
}

export function buildNotationPrompt(symbol: string, readingPage: string, excerpts: NotationExcerpt[]): string {
  const body = excerpts
    .map((excerpt) => `[${excerpt.label}${excerpt.isReadingPage ? " ★" : ""}, p. ${excerpt.pageLabel}] ${excerpt.text}`)
    .join("\n\n");
  return `Symbol: "${symbol || "(see the attached image)"}"
Reading on p. ${readingPage} ★

Excerpts:

${body || "(none found — the symbol's text couldn't be found in the document)"}`;
}

export interface ParsedNotationReply {
  source?: GlossarySource;
  symbolLatex?: string;
  definition: string;
  definedIn?: string;
}

const SOURCES: GlossarySource[] = ["defined", "inferred", "general"];

// Lenient, and safe to run on every streamed chunk: fields not yet arrived
// stay unset, and a label line still arriving isn't shown as the meaning.
export function parseNotationReply(raw: string): ParsedNotationReply {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let source: GlossarySource | undefined;
  let symbolLatex: string | undefined;
  let definedIn: string | undefined;
  const body: string[] = [];
  let inTrailer = false;
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    const isLast = i === lines.length - 1;
    const field = /^(SOURCE|SYMBOL|DEFINED_IN)\s*:\s*(.*)$/i.exec(trimmed);
    if (field) {
      const name = field[1].toUpperCase();
      const value = field[2].trim();
      if (name === "SOURCE") {
        const v = value.toLowerCase() as GlossarySource;
        if (SOURCES.includes(v)) source = v;
      } else if (name === "SYMBOL") {
        if (value) symbolLatex = value;
      } else {
        inTrailer = true;
        const label = /S\d+/i.exec(value);
        if (label) definedIn = label[0].toUpperCase();
      }
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      inTrailer = true;
      continue;
    }
    // A label still streaming in ("SOU", "SYMB", "DEFIN", "--").
    if (isLast && /^(?:S(?:O(?:U(?:R(?:C(?:E)?)?)?)?)?|S(?:Y(?:M(?:B(?:O(?:L)?)?)?)?)?|D(?:E(?:F(?:I(?:N(?:E(?:D(?:_(?:I(?:N)?)?)?)?)?)?)?)?)?|-{1,2})$/i.test(trimmed)) {
      continue;
    }
    if (!inTrailer) body.push(line);
  }
  return { source, symbolLatex, definition: body.join("\n").trim(), definedIn };
}
