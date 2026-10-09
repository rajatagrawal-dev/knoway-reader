import type { PDFDocumentProxy } from "pdfjs-dist";
import { streamAskReply } from "../deepdive/api";
import {
  buildAskSystem,
  isFollowUp,
  NOTHING_RELEVANT_ANSWER,
  selectAskSources,
  type AskBasis,
  type AskScope,
} from "../grounding/ask";
import { markersToPages } from "../grounding/citations";
import {
  attachmentImages,
  attachmentInstructions,
  attachmentQuery,
  attachmentSources,
  type Attachment,
} from "../grounding/attachments";
import type { SourceRef } from "../grounding/types";
import { inferScope } from "../grounding/scope";
import { getBm25, getChunks, getSections, getTextIndex } from "../text/documentText";
import type { AskStore } from "./store";
import type { AskThread, AskTurn } from "./types";

// Answering one question in a thread: choose the passages (grounding/ask.ts),
// skip the model when none are relevant, otherwise stream the answer into the
// store. Runs outside React (see store.ts).

export interface AskContext {
  pdfDocument: PDFDocumentProxy;
  fileName: string;
  pageLabel: (pageNumber: number) => string;
  pageLabels: string[] | null;
  currentPage: number; // what "this page" / "this chapter" means
}

export interface AskOptions {
  // Re-answer the thread's last question instead of asking a new one —
  // "Search wider" and "Answer from general knowledge" replace the answer
  // they're shown under.
  retry?: { wider?: boolean; generalAllowed?: boolean };
  // "More detail": a follow-up answered from the last answer's passages.
  reuseSources?: boolean;
  // Text the reader added to this question.
  attachments?: Attachment[];
}

export const MORE_DETAIL_QUESTION = "More detail, please.";

// Earlier exchanges re-sent with a question: the last two (roadmap §5.2).
const HISTORY_TURNS = 4;

const now = () => new Date().toISOString();

const DOCUMENT: AskScope = { kind: "document" };

// What the question is about: read from its wording ("this chapter",
// "page 42"), else the whole document. A retry keeps the scope its
// answer had.
async function scopeFor(question: string, thread: AskThread, context: AskContext, retry: boolean): Promise<AskScope> {
  if (retry) return lastAnswer(thread.turns)?.scope ?? DOCUMENT;
  const sections = await getSections(context.pdfDocument).catch(() => []);
  return inferScope(question, {
    currentPage: context.currentPage,
    numPages: context.pdfDocument.numPages,
    sections,
    pageLabels: context.pageLabels,
  });
}

export function newThread(question: string): AskThread {
  const at = now();
  const title = question.replace(/\s+/g, " ").trim();
  return {
    id: crypto.randomUUID(),
    title: title.length > 80 ? `${title.slice(0, 79)}…` : title,
    turns: [],
    createdAt: at,
    updatedAt: at,
  };
}

function lastAnswer(turns: AskTurn[]): AskTurn | undefined {
  return [...turns].reverse().find((turn) => turn.role === "assistant" && turn.status !== "error" && turn.sources);
}

function sameScope(a: AskScope, b: AskScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// What the question is answered from. A thread whose last answer already
// had the whole scope keeps it: the model can answer anything in it, and
// the identical prefix is a prompt-cache hit rather than a new bill.
// The last question's regions (sent as images), for a bare follow-up about them.
function previousRegions(turns: AskTurn[]): Attachment[] {
  const questions = turns.filter((turn) => turn.role === "user");
  const previous = questions[questions.length - 2]; // the last one is the question being asked
  return previous?.attachments?.filter((a) => a.kind === "region") ?? [];
}

async function chooseSources(
  thread: AskThread,
  question: string,
  scope: AskScope,
  context: AskContext,
  options: AskOptions,
  attachments: Attachment[],
): Promise<{ sources: SourceRef[]; basis: AskBasis; carried?: Attachment[] }> {
  const previous = lastAnswer(thread.turns);
  if (options.reuseSources && previous?.sources) {
    return { sources: previous.sources, basis: previous.basis ?? { kind: "passages", count: previous.sources.length } };
  }
  if (
    !options.retry &&
    attachments.length === 0 &&
    previous?.basis?.kind === "scope" &&
    previous.sources &&
    sameScope(scope, previous.scope ?? DOCUMENT)
  ) {
    return { sources: previous.sources, basis: previous.basis };
  }
  const [index, chunks, bm25] = await Promise.all([
    getTextIndex(context.pdfDocument),
    getChunks(context.pdfDocument),
    getBm25(context.pdfDocument),
  ]);
  const userTurns = thread.turns.filter((turn) => turn.role === "user" && turn.content !== MORE_DETAIL_QUESTION);
  const previousQuestion = userTurns.length > 1 ? userTurns[userTurns.length - 2].content : undefined;
  const selection = selectAskSources({
    chunks,
    bm25,
    question,
    previousQuestion,
    scope,
    wider: options.retry?.wider,
    attached: attachmentSources(attachments, index),
    extraQuery: attachmentQuery(attachments),
  });
  // "And why?" after an answer about something the search can't find again
  // (a passage found by its wording, an attached region): answered from what
  // that answer had — its passages, and the regions its question sent —
  // rather than "not covered".
  const carried = attachments.length === 0 ? previousRegions(thread.turns) : [];
  if (
    selection.sources.length === 0 &&
    !options.retry &&
    previous &&
    (previous.sources?.length || carried.length) &&
    isFollowUp(question)
  ) {
    const sources = previous.sources ?? [];
    return { sources, basis: previous.basis ?? { kind: "passages", count: sources.length }, carried };
  }
  return selection;
}

export async function ask(
  store: AskStore,
  threadId: string,
  question: string,
  context: AskContext,
  options: AskOptions = {},
): Promise<void> {
  const thread = store.get(threadId);
  if (!thread) return;

  // The question being answered (with anything the reader attached to it),
  // and the thread as it stands before its answer.
  let asked = question;
  let attachments = options.attachments ?? [];
  if (options.retry) {
    const turns = [...thread.turns];
    while (turns.length && turns[turns.length - 1].role === "assistant") turns.pop();
    asked = turns[turns.length - 1]?.content ?? question;
    attachments = turns[turns.length - 1]?.attachments ?? [];
    store.update(threadId, (t) => ({ ...t, turns, updatedAt: now() }));
  } else {
    const turn: AskTurn = { role: "user", content: question, at: now(), ...(attachments.length ? { attachments } : {}) };
    store.update(threadId, (t) => ({ ...t, turns: [...t.turns, turn], updatedAt: now() }));
  }
  const before = store.get(threadId)!;
  const generalAllowed = options.retry?.generalAllowed ?? false;
  const scopeAtAsk = await scopeFor(asked, thread, context, Boolean(options.retry));

  let sources: SourceRef[];
  let basis: AskBasis;
  // What this question sends: its own attachments, plus — for a bare
  // follow-up answered from the last answer's context — the regions the
  // last question sent (not stored again on this one).
  let sent = attachments;
  try {
    let carried: Attachment[] | undefined;
    ({ sources, basis, carried } = await chooseSources(before, asked, scopeAtAsk, context, options, attachments));
    if (carried?.length) sent = [...attachments, ...carried];
  } catch {
    sources = [];
    basis = { kind: "none" };
  }
  const answerMeta = {
    sources,
    basis,
    scope: scopeAtAsk,
    ...(options.retry?.wider ? { wider: true } : {}),
    ...(generalAllowed ? { generalAllowed: true } : {}),
  };

  // Nothing relevant: say so at no cost; the reader can widen or allow
  // general knowledge from there.
  if (sources.length === 0 && sent.length === 0 && !generalAllowed) {
    store.update(threadId, (t) => ({
      ...t,
      turns: [...t.turns, { role: "assistant", content: NOTHING_RELEVANT_ANSWER, at: now(), ...answerMeta }],
      updatedAt: now(),
    }));
    return;
  }

  // Attached passages are the only sources not cut from a chunk.
  const attachedLabels = sent.length ? sources.filter((source) => !source.chunkId).map((source) => source.label) : [];
  const system = buildAskSystem({
    fileName: context.fileName,
    scope: scopeAtAsk,
    basis,
    sources,
    generalAllowed,
    pageLabel: context.pageLabel,
    attachmentNote: attachmentInstructions(sent, attachedLabels, context.pageLabel),
  });
  const history = before.turns.filter((turn) => turn.status !== "error" && turn.status !== "streaming");
  const recent = history.slice(Math.max(0, history.length - 1 - HISTORY_TURNS));
  // Providers want user/assistant alternating, starting with the user; a
  // failed answer (left out above) can leave two questions in a row, which
  // go as one message.
  const messages: { role: AskTurn["role"]; content: string; images?: ReturnType<typeof attachmentImages> }[] = [];
  for (const turn of recent) {
    const content =
      turn.role === "assistant" ? markersToPages(turn.content, turn.sources ?? [], context.pageLabel) : turn.content;
    const last = messages[messages.length - 1];
    if (!last && turn.role === "assistant") continue;
    if (last?.role === turn.role) last.content += `\n\n${content}`;
    else messages.push({ role: turn.role, content });
  }
  // Regions the reader added go, as images, with the question itself — not
  // resent with later questions.
  const images = attachmentImages(sent);
  if (images.length && messages.length) messages[messages.length - 1].images = images;

  const index = before.turns.length;
  store.update(threadId, (t) => ({
    ...t,
    turns: [...t.turns, { role: "assistant", content: "", at: now(), status: "streaming", ...answerMeta }],
  }), { persist: false });
  const setAnswer = (patch: Partial<AskTurn>, persist: boolean) =>
    store.update(
      threadId,
      (t) => ({ ...t, turns: t.turns.map((turn, i) => (i === index ? { ...turn, ...patch } : turn)), updatedAt: now() }),
      { persist },
    );

  let streamed = "";
  try {
    const full = await streamAskReply({
      system,
      messages,
      onText: (chunk) => {
        streamed += chunk;
        setAnswer({ content: streamed }, false);
      },
    });
    if (!full.trim()) throw new Error("The model returned an empty answer. Try asking again.");
    setAnswer({ content: full, status: undefined }, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The answer failed.";
    setAnswer({ content: `⚠️ ${message}`, status: "error" }, true);
  }
}
