import type { TextChunk } from "../text/chunks.ts";
import { overlapsAny } from "./attachments.ts";
import { labelSources } from "./context.ts";
import { GROUNDING_RULES, MATH_RULES, renderSources } from "./prompt.ts";
import { selectRelevant, type Bm25Index } from "./retrieval.ts";
import type { SourceRef } from "./types.ts";

// What an Ask question sends the model (roadmap §5.2, §6.2): the passages
// clearly relevant to it — or the whole chapter/document when the question
// is about it as a whole — and nothing else.

export type AskScope =
  | { kind: "document" }
  | { kind: "section"; title: string; from: number; to: number }
  | { kind: "page"; page: number };

// What an answer rests on, shown under it: "Based on 4 passages" /
// "Based on all of Chapter 3" / "Based on part of the document".
export type AskBasis =
  | { kind: "passages"; count: number }
  | { kind: "scope" }
  | { kind: "partial"; count: number }
  | { kind: "none" };

export const ASK_BUDGET = { typicalChars: 4000, ceilingChars: 200_000 };
// "Search wider": more passages, including less clearly relevant ones.
export const ASK_WIDER = { typicalChars: 12_000, ceilingChars: 200_000, relativeCutoff: 0.2 };
// When the clearly relevant passages already make up this much of the scope,
// sending all of it costs little more and reads better.
const WHOLE_SCOPE_SHARE = 0.6;

export function inScope(chunk: TextChunk, scope: AskScope): boolean {
  if (scope.kind === "document") return true;
  if (scope.kind === "page") return chunk.pageNumber === scope.page;
  return chunk.pageNumber >= scope.from && chunk.pageNumber <= scope.to;
}

export function scopeLabel(scope: AskScope, pageLabel: (pageNumber: number) => string): string {
  if (scope.kind === "document") return "the whole document";
  if (scope.kind === "page") return `p. ${pageLabel(scope.page)}`;
  return scope.title;
}

// Questions about a scope as a whole — its argument, a summary, everything of
// some kind in it — rather than about something in it.
const WHOLE_SCOPE_QUESTION =
  /\b(summari[sz]e|summary|overview|outline|gist|tl;?dr|big picture|main (?:idea|point|argument|claim|theme|takeaway|contribution|result)s?|key (?:idea|point|takeaway|concept|result)s?|what(?:'s| is| are) (?:this|the) (?:chapter|section|paper|document|book|article|text|page)(?:'s)? (?:about|saying|arguing)|what does (?:this|the) (?:chapter|section|paper|document|book|article|text|page) (?:say|cover|argue|discuss)|(?:list|name) (?:all|every|each)|all the (?:theorems|definitions|lemmas|examples|exercises|equations|figures|claims|results|terms)|structure of (?:this|the))\b/i;

export function wantsWholeScope(question: string): boolean {
  return WHOLE_SCOPE_QUESTION.test(question);
}

// A follow-up that leans on the previous question ("why?", "how does it
// work?", "give an example") — searched together with it. Anything else is
// searched on its own, so an unrelated question isn't answered from the last
// one's passages.
const FOLLOW_UP = /\b(it|its|this|that|these|those|they|them|their|why|how so|more|example|elaborate|explain|else|also)\b/i;

export function isFollowUp(question: string): boolean {
  return FOLLOW_UP.test(question);
}

export interface AskSelection {
  sources: SourceRef[];
  basis: AskBasis;
}

export function selectAskSources(params: {
  chunks: TextChunk[];
  bm25: Bm25Index;
  question: string;
  previousQuestion?: string; // gives a follow-up ("why?") something to search with
  scope: AskScope;
  wider?: boolean;
  // Passages the reader added to the question: always sent, and their text
  // helps find related passages elsewhere.
  attached?: SourceRef[];
  extraQuery?: string;
}): AskSelection {
  const { chunks, bm25, question, previousQuestion, scope, wider, attached = [], extraQuery = "" } = params;
  const scoped = chunks.filter((chunk) => inScope(chunk, scope));
  const scopeChars = scoped.reduce((sum, chunk) => sum + chunk.text.length, 0);
  const toSources = (list: TextChunk[]) =>
    labelSources([
      ...attached,
      ...list
        .map((chunk) => ({
          label: "",
          pageNumber: chunk.pageNumber,
          start: chunk.start,
          end: chunk.end,
          text: chunk.text,
          chunkId: chunk.id,
        }))
        .filter((source) => !overlapsAny(source, attached)),
    ]);
  const whole = (): AskSelection => ({ sources: toSources(scoped), basis: { kind: "scope" } });

  if (scoped.length === 0) {
    return attached.length ? { sources: toSources([]), basis: { kind: "passages", count: attached.length } } : { sources: [], basis: { kind: "none" } };
  }
  if (wantsWholeScope(question) && scopeChars <= ASK_BUDGET.ceilingChars) return whole();

  // Out of scope, or already sent as an attached passage — excluded before
  // ranking, so an attached passage's own chunk doesn't set the bar for
  // what else counts as relevant.
  const outOfScope = new Set(
    chunks
      .filter((chunk) => !inScope(chunk, scope) || overlapsAny({ ...chunk, label: "" }, attached))
      .map((chunk) => chunk.id),
  );
  const budget = wider ? ASK_WIDER : ASK_BUDGET;
  const searchText = `${question} ${extraQuery}`.trim();
  let relevant = selectRelevant(bm25, searchText, { ...budget, exclude: outOfScope });
  if (relevant.length === 0 && previousQuestion && FOLLOW_UP.test(question)) {
    relevant = selectRelevant(bm25, `${previousQuestion} ${question}`, { ...budget, exclude: outOfScope });
  }

  // A whole-scope question over more text than the ceiling allows: the most
  // relevant part of it, said so.
  if (wantsWholeScope(question)) {
    const list = relevant.length ? relevant.map((r) => r.chunk) : scoped.slice(0, 8);
    return { sources: toSources(list), basis: { kind: "partial", count: list.length } };
  }
  if (relevant.length === 0 && attached.length === 0) return { sources: [], basis: { kind: "none" } };

  const chosenChars = relevant.reduce((sum, r) => sum + r.chunk.text.length, 0);
  if (relevant.length && chosenChars >= WHOLE_SCOPE_SHARE * scopeChars && scopeChars <= ASK_BUDGET.ceilingChars) return whole();
  const sources = toSources(relevant.map((r) => r.chunk));
  return { sources, basis: { kind: "passages", count: sources.length } };
}

export function buildAskSystem(params: {
  fileName: string;
  scope: AskScope;
  basis: AskBasis;
  sources: SourceRef[];
  generalAllowed: boolean;
  pageLabel: (pageNumber: number) => string;
  // What the reader added to this question (grounding/attachments.ts) —
  // last, since it changes with every question while the rest can stay a
  // cacheable prefix.
  attachmentNote?: string;
}): string {
  const { fileName, scope, basis, sources, generalAllowed, pageLabel, attachmentNote } = params;
  const where = scope.kind === "document" ? "" : ` The reader is asking about ${scopeLabel(scope, pageLabel)}.`;
  const partial =
    basis.kind === "partial"
      ? " These are only the most relevant parts of it, not all of it: say so if the question needs the rest."
      : "";
  const general = generalAllowed
    ? "\n- The reader asked for an answer even where the document doesn't cover it: answer from general knowledge there, marking those claims [general]. Don't reply [not-covered]."
    : "";
  // Sources first and fixed across a thread's follow-ups, so a large context
  // is a stable prefix the provider can serve from its prompt cache.
  return `You help a reader study a PDF titled "${fileName}". Answer their question using these passages from it.${where}${partial}

Sources from the document:
${sources.length ? renderSources(sources, pageLabel) : "(none — no passage of the document addresses this)"}

${GROUNDING_RULES}${general}

${MATH_RULES}${attachmentNote ? `\n\n${attachmentNote}` : ""}`;
}

// The reader is told "not covered" without a model call when nothing
// relevant was found — worded like the model's own [not-covered] reply, so
// the answer's badge and actions work the same either way.
export const NOTHING_RELEVANT_ANSWER = "[not-covered] Nothing in this part of the document seems to address that.";
