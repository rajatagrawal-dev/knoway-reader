import type { SourceRef } from "./types.ts";

// The sources block and the shared answering rules every grounded surface
// puts in its system prompt. Kept compact: this text is paid for on every
// request.

export function renderSources(sources: SourceRef[], pageLabel: (pageNumber: number) => string): string {
  return sources
    .map((source) => {
      // Only the dive context experiments set these; without them the
      // block is exactly as before.
      const is = source.is ? ` is="${source.is.replace(/"/g, "'")}"` : "";
      const sec = source.section ? ` sec="${source.section.replace(/"/g, "'")}"` : "";
      return `<source id="${source.label}" p="${pageLabel(source.pageNumber)}"${is}${sec}>${source.text}</source>`;
    })
    .join("\n");
}

export const GROUNDING_RULES = `How to answer:
- Answer first, in one to three plain sentences. Add short steps or bullets only if the question truly needs them. Stay under about 120 words unless the reader asks for more. No preamble, no recap, don't restate the question.
- After each claim taken from a source, cite it by id: [S2] (several: [S2][S5]). For something you reasoned from the sources rather than read there: [inferred: S2]. For anything from outside the sources: [general].
- Quote the document only word for word, in quotation marks, followed by its citation — prose only; never quote a formula (write it in LaTeX instead).
- Never cite an id that isn't listed above.
- If the sources don't address the question at all, reply only "[not-covered]" and one sentence saying so.`;

// How answers write math — every grounded surface (Deep Dive, Ask) uses it,
// so equations render the same everywhere. The sources are text extracted
// from the PDF, where formulas often come out garbled (superscripts
// flattened, symbols split: "e−|α|2/2" for e^{-|α|^2/2}); copied as is, they
// can't be rendered as math at all.
export const MATH_RULES = `Formatting: markdown with KaTeX math.
- Write every mathematical expression, even a lone variable, as LaTeX in $...$ — never raw ^, unicode superscripts or subscripts, √, Σ, ⟩, or bare Greek letters.
- Put any equation that matters on its own line as $$...$$, with a blank line before and after.
- Formulas in the sources come from the PDF's extracted text and are often garbled (superscripts flattened, symbols split apart). Reconstruct the intended formula as proper LaTeX; never copy formula text from a source as is.`;
