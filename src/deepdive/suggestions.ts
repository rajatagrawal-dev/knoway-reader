import { citedSources } from "../grounding/citations.ts";
import type { SourceRef } from "../grounding/types.ts";
import type { DiveTurn } from "./types.ts";

// Suggested next steps after a dive answer (the suggestions experiment):
// the model ends its answer with a <next> block (see prompts.ts), read out
// here and shown as pills instead of text. "ask" continues in the same
// dive; "dive" opens a nested dive on a concept, anchored to the passage
// that states it; "diagram" asks for a diagram of the answer.

export interface DiveSuggestion {
  kind: "ask" | "dive" | "diagram";
  text: string;
  sourceLabel?: string; // "S3": where the document states or defines it
  fromContext?: boolean; // found in the dive's own sources, not proposed by the model
}

const MAX_SUGGESTIONS = 5;
const MAX_FROM_CONTEXT = 2;

const LINE = /^\s*[-*•]?\s*(ask|dive|diagram)\s*:\s*(.+?)\s*$/i;
const CITATION = /\s*\[\s*(?:inferred\s*:?\s*)?(S\d+)(?:\s*,\s*S\d+)*\s*\]\s*$/i;

// The answer without its <next> block, and the suggestions in it. A block
// without its closing tag (cut off at the token limit) still counts.
export function splitSuggestions(text: string): { body: string; suggestions: DiveSuggestion[] } {
  const open = text.search(/<next>/i);
  if (open === -1) return { body: text, suggestions: [] };
  const rest = text.slice(open + "<next>".length);
  const close = rest.search(/<\/next>/i);
  const block = close === -1 ? rest : rest.slice(0, close);
  const after = close === -1 ? "" : rest.slice(close + "</next>".length);
  const suggestions: DiveSuggestion[] = [];
  for (const line of block.split("\n")) {
    const match = LINE.exec(line);
    if (!match) continue;
    let value = match[2].replace(/\[\s*general\s*\]\s*$/i, "").trim();
    const cited = CITATION.exec(value);
    if (cited) value = value.slice(0, cited.index).trim();
    value = value.replace(/^["“]|["”]$/g, "").trim();
    if (!value) continue;
    suggestions.push({
      kind: match[1].toLowerCase() as DiveSuggestion["kind"],
      text: value,
      ...(cited ? { sourceLabel: cited[1].toUpperCase() } : {}),
    });
  }
  return { body: `${text.slice(0, open)}${after}`.trimEnd(), suggestions: suggestions.slice(0, MAX_SUGGESTIONS) };
}

// An answer's <next> block isn't shown; while the answer streams in,
// neither is the start of its tag.
export function hideSuggestionBlock(text: string, streaming = true): string {
  const open = text.search(/<next>/i);
  if (open !== -1) return text.slice(0, open);
  if (!streaming) return text;
  const partial = /<(?:n(?:e(?:x(?:t)?)?)?)?$/i.exec(text);
  return partial ? text.slice(0, partial.index) : text;
}

// A linked source's name as a dive topic: "Eq. (3.2)", or the term or
// symbol in "definition of …".
function topicOf(source: SourceRef): string | null {
  if (!source.is || source.is.endsWith("(cont.)")) return null;
  const defined = /^definition of "?(.+?)"?$/.exec(source.is);
  return defined ? defined[1] : source.is;
}

// The model's suggestions, then up to two dive topics found in the dive's
// own sources (what the selection names) that it didn't already suggest.
export function mergeSuggestions(fromModel: DiveSuggestion[], sources: SourceRef[] | undefined): DiveSuggestion[] {
  const seen = new Set(fromModel.map((suggestion) => suggestion.text.toLowerCase()));
  const extra: DiveSuggestion[] = [];
  for (const source of sources ?? []) {
    if (extra.length >= MAX_FROM_CONTEXT) break;
    if (source.via !== "xref" && source.via !== "symbol" && source.via !== "term") continue;
    const topic = topicOf(source);
    if (!topic || seen.has(topic.toLowerCase())) continue;
    seen.add(topic.toLowerCase());
    extra.push({ kind: "dive", text: topic, sourceLabel: source.label, fromContext: true });
  }
  return [...fromModel, ...extra].slice(0, MAX_SUGGESTIONS);
}

// The panel a suggested dive would open, for resolving its sources ahead
// of the click (App's prefetch): its topic, hung from the answer that
// suggested it, inheriting the passage the suggestion cited and whatever
// that answer cited.
export function suggestedDiveSources(turn: DiveTurn, sourceLabel: string | undefined): SourceRef[] | undefined {
  const sources = turn.sources ?? [];
  const suggested = sourceLabel ? sources.filter((source) => source.label === sourceLabel) : [];
  const cited = citedSources(turn.content, sources).filter((source) => !suggested.includes(source));
  const inherited = [...suggested, ...cited];
  return inherited.length ? inherited : undefined;
}
