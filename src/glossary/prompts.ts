import type { GlossaryReference, ReferenceLookup } from "./types";

export interface GlossaryExcerpt {
  label: string; // "S1", "S2", ... — how the model cites it back in DEFINED_IN
  pageLabel: string;
  text: string;
  isDefinition: boolean; // reads like where the document defines the term (see findDefiningMatch)
}

export function buildGlossarySystem(fileName: string): string {
  return `You write glossary entries for a reader studying a PDF titled "${fileName}". You are given a term and numbered excerpts from the document where it appears. Define the term the way THIS document uses it.

Reply in exactly this format, with nothing before or after it:
SOURCE: defined | inferred | general
ORIGIN: common | technical | foreign | name | abbreviation; <detail>
<definition>
---
DEFINED_IN: <label of the excerpt that defines or introduces the term, e.g. S3, or none>
ALIASES: <other names or abbreviations the excerpts use for the same thing, separated by ";", or none>
LITERAL: <word-for-word meaning, or none>
REFERENCE: <label of the reference entry that matches this document's sense, e.g. D2 or W1, or none>

SOURCE is "defined" if an excerpt explicitly defines or introduces the term, "inferred" if you worked the meaning out from how the excerpts use it, and "general" if the excerpts don't reveal the meaning and you're giving its standard meaning in this document's field.

ORIGIN says what kind of term it is, as this document uses it, with a detail of one to three words:
- common: an everyday word or phrase used in its ordinary sense; detail is the language (e.g. "common; English").
- technical: a term of a field, including an everyday word the document uses in a specialized sense; detail is the field (e.g. "technical; quantum computing").
- foreign: a word or phrase from another language than the document's, including loan phrases such as "ad hoc" or "raison d'être"; detail is that language (e.g. "foreign; Latin").
- name: a proper name; detail is what it names: person, place, organization, product, work, theorem, ... (e.g. "name; person").
- abbreviation: an acronym or abbreviation; detail is the field.

LITERAL is the word-for-word translation, in a few words and without quotes, of a foreign word or phrase, or of an idiom or compound whose literal meaning differs from its meaning (e.g. "ad hoc" → for this; "Zeitgeist" → spirit of the time). Otherwise none.

Reference entries, when given, come from a dictionary (D labels) and an encyclopedia (W labels) looked up by the term's spelling alone, so they may describe other senses or other things entirely. REFERENCE is the one entry that matches the term's meaning in THIS document — prefer a dictionary sense for a common or foreign word, an encyclopedia article for a technical concept or a name — or none if no entry matches. Your definition stays grounded in the excerpts; use the entries only to confirm the standard meaning, which matters most when SOURCE is general.

The definition — accuracy first, then simplicity:
- It must be accurate to how THIS document uses the term. Never trade accuracy for simplicity: if a plainer wording would be wrong or misleading, keep the precision that's needed.
- Within that, make it as simple as possible, for a reader meeting the term for the first time. If an excerpt already gives a plain definition, build on it and stay close to its wording rather than a more technical formulation found elsewhere.
- One or two short sentences, at most 40 words. Say what the thing is; leave out properties, examples, applications and consequences unless one is needed to say what it is. Start directly with the meaning — don't restate the term or open with "This term refers to".
- Prefer everyday words to jargon when they're just as accurate; when another technical term is unavoidable, use one the document itself uses.
- Avoid formulas, symbols and variables. Use them only when the term can't be defined accurately without them, and then keep to the minimum, written as LaTeX in $...$.
- If the document uses the term in a specialized or unusual sense, say so. Mention more than one sense only if the excerpts clearly use more than one.
- Don't add claims the excerpts don't support (unless SOURCE is general). No headings, lists, or bold.

Excerpts may use related forms of the term (e.g. "entangled" for "entanglement"); a definition given for such a form counts as defining the term.

An excerpt marked ★ reads like the term's definition, judging by its wording alone. Check it rather than trusting the mark: the definition may be elsewhere, or nowhere.

ALIASES lists only names that actually appear in the excerpts (e.g. an abbreviation introduced in parentheses), never inflections of the term itself.`;
}

// A dictionary sense or encyclopedia article the model can pick by label,
// and what the reader is shown if it does.
export interface ReferenceCandidate {
  label: string; // "D1", "W2"
  reference: GlossaryReference;
}

export function referenceCandidates(lookup: ReferenceLookup | null): ReferenceCandidate[] {
  if (!lookup) return [];
  const candidates: ReferenceCandidate[] = [];
  const dictionary = lookup.dictionary;
  for (const entry of dictionary?.entries ?? []) {
    for (const sense of entry.senses) {
      candidates.push({
        label: `D${candidates.length + 1}`,
        reference: {
          site: "Wiktionary",
          label: `${entry.language} ${entry.partOfSpeech.toLowerCase()}`,
          text: sense,
          url: `${dictionary!.url}#${entry.language.replace(/ /g, "_")}`,
        },
      });
    }
  }
  lookup.encyclopedia.forEach((article, i) => {
    candidates.push({
      label: `W${i + 1}`,
      reference: { site: "Wikipedia", label: article.title, text: article.extract, url: article.url },
    });
  });
  return candidates;
}

export function buildGlossaryPrompt(term: string, excerpts: GlossaryExcerpt[], references: ReferenceCandidate[] = []): string {
  const body = excerpts
    .map((excerpt) => `[${excerpt.label}${excerpt.isDefinition ? " ★" : ""}, p. ${excerpt.pageLabel}] ${excerpt.text}`)
    .join("\n\n");
  const lookup = references.length
    ? references
        .map(({ label, reference }) =>
          reference.site === "Wiktionary"
            ? `[${label}, dictionary, ${reference.label}] ${reference.text}`
            : `[${label}, encyclopedia: ${reference.label}] ${reference.text}`,
        )
        .join("\n")
    : "none";
  const marked = excerpts.some((excerpt) => excerpt.isDefinition);
  return `Term: "${term}"

Excerpts${marked ? " (★ marks the one that appears to define the term)" : ""}:

${body}

Reference entries:

${lookup}`;
}
