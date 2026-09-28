export interface GlossaryExcerpt {
  label: string; // "S1", "S2", ... — how the model cites it back in DEFINED_IN
  pageLabel: string;
  text: string;
  isSelection: boolean; // from the page the reader selected the term on
}

export function buildGlossarySystem(fileName: string): string {
  return `You write glossary entries for a reader studying a PDF titled "${fileName}". You are given a term and numbered excerpts from the document where it appears. Define the term the way THIS document uses it.

Reply in exactly this format, with nothing before or after it:
SOURCE: defined | inferred | general
<definition>
---
DEFINED_IN: <label of the excerpt that defines or introduces the term, e.g. S3, or none>
ALIASES: <other names or abbreviations the excerpts use for the same thing, separated by ";", or none>

SOURCE is "defined" if an excerpt explicitly defines or introduces the term, "inferred" if you worked the meaning out from how the excerpts use it, and "general" if the excerpts don't reveal the meaning and you're giving its standard meaning in this document's field.

The definition — accuracy first, then simplicity:
- It must be accurate to how THIS document uses the term. Never trade accuracy for simplicity: if a plainer wording would be wrong or misleading, keep the precision that's needed.
- Within that, make it as simple as possible, for a reader meeting the term for the first time. If an excerpt already gives a plain definition, build on it and stay close to its wording rather than a more technical formulation found elsewhere.
- One or two short sentences, at most 40 words. Say what the thing is; leave out properties, examples, applications and consequences unless one is needed to say what it is. Start directly with the meaning — don't restate the term or open with "This term refers to".
- Prefer everyday words to jargon when they're just as accurate; when another technical term is unavoidable, use one the document itself uses.
- Avoid formulas, symbols and variables. Use them only when the term can't be defined accurately without them, and then keep to the minimum, written as LaTeX in $...$.
- If the document uses the term in a specialized or unusual sense, say so. Mention more than one sense only if the excerpts clearly use more than one.
- Don't add claims the excerpts don't support (unless SOURCE is general). No headings, lists, or bold.

Excerpts may use related forms of the term (e.g. "entangled" for "entanglement"); a definition given for such a form counts as defining the term.

ALIASES lists only names that actually appear in the excerpts (e.g. an abbreviation introduced in parentheses), never inflections of the term itself.`;
}

export function buildGlossaryPrompt(term: string, excerpts: GlossaryExcerpt[]): string {
  const body = excerpts
    .map((excerpt) => `[${excerpt.label}${excerpt.isSelection ? " ★" : ""}, p. ${excerpt.pageLabel}] ${excerpt.text}`)
    .join("\n\n");
  return `Term: "${term}"

Excerpts (★ marks where the reader selected it):

${body}`;
}
