import type { PDFDocumentProxy } from "pdfjs-dist";
import { isFollowUp } from "../grounding/ask";
import { attachmentQuery, attachmentSources, type Attachment } from "../grounding/attachments";
import { citedSources, markersToPages } from "../grounding/citations";
import { buildDiveSources, buildFollowUpSources, locateSelection } from "../grounding/context";
import type { LinkTerm } from "../grounding/links";
import type { SourceRef } from "../grounding/types";
import type { DocumentTextIndex } from "../glossary/textIndex";
import type { GlossaryEntry } from "../glossary/types";
import { meaningAt } from "../notation/symbols";
import { getBm25, getChunks, getSections, getTextIndex } from "../text/documentText";
import type { CommentedHighlight } from "../types";
import { getXrefIndex } from "../xref/xrefIndex";
import { contextStrategy, type DiveExperiments } from "./experiments";
import type { DivePromptOptions } from "./prompts";
import { readerNotesBlock } from "./readerNotes";
import { rootPanelOf } from "./tree";
import type { DivePanel, DiveTurn } from "./types";

// Everything a dive request is built from beyond the panel itself: the
// document's text, the reader's notes, and which experiments are on. With
// every experiment off this is exactly the original request.

export interface DiveRequestContext {
  pdf: PDFDocumentProxy;
  pageLabel: (pageNumber: number) => string;
  panels: DivePanel[];
  highlights: CommentedHighlight[];
  glossary: GlossaryEntry[];
  experiments: DiveExperiments;
}

const highlightPage = (ctx: DiveRequestContext, id: string | null) =>
  id ? ctx.highlights.find((highlight) => highlight.id === id)?.position.boundingRect.pageNumber : undefined;

// The page a panel's dive is about: its own, or for a nested dive its
// tree's.
export function panelPage(ctx: DiveRequestContext, panel: DivePanel): number | undefined {
  return panel.pageNumber ?? highlightPage(ctx, panel.anchorHighlightId);
}

// Glossary terms located where the document defines them, for linking.
function linkTerms(glossary: GlossaryEntry[], index: DocumentTextIndex): LinkTerm[] {
  return glossary
    .filter((entry) => entry.status === "done" && entry.kind !== "symbol")
    .map((entry) => {
      const ref = entry.definedRefId ? entry.refs.find((r) => r.id === entry.definedRefId) : undefined;
      const range = ref ? locateSelection(index, ref.pageNumber, `${ref.before}${ref.match}${ref.after}`) : null;
      return {
        term: entry.term,
        aliases: entry.aliases,
        ...(ref && range ? { definedAt: { pageNumber: ref.pageNumber, start: range[0] + ref.before.length } } : {}),
      };
    });
}

const firstAnswer = (panel: DivePanel | null): DiveTurn | undefined =>
  panel?.turns.find((turn) => turn.role === "assistant" && turn.sources && !turn.content.startsWith("⚠️"));

// A nested dive's anchor: the passage its tree started from, as the root's
// first answer was given it — the passages on the root's page first.
function rootAnchorSources(root: DivePanel, rootPage: number | undefined): SourceRef[] {
  const turn = firstAnswer(root);
  if (!turn?.sources) return [];
  const onPage = turn.sources.filter((source) => source.pageNumber === rootPage);
  return (onPage.length ? onPage : citedSources(turn.content, turn.sources)).slice(0, 2);
}

// The sources a request may cite, and — with stable sources — where this
// question's additions start (see DivePromptOptions.splitAt). Undefined when
// the document's text isn't available: the dive then falls back to its
// unlabeled page context.
export async function prepareDiveSources(
  ctx: DiveRequestContext,
  panel: DivePanel,
  content: string,
  options: { reuse: boolean; attachments: Attachment[] },
): Promise<{ sources: SourceRef[]; splitAt?: number } | undefined> {
  const x = ctx.experiments;
  if (options.reuse) {
    const previous = [...panel.turns].reverse().find((turn) => turn.role === "assistant" && turn.sources);
    if (previous?.sources) {
      const splitAt = x.stableSources && panel.baseSources ? Math.min(panel.baseSources.length, previous.sources.length) : undefined;
      return { sources: previous.sources, splitAt };
    }
  }
  try {
    const [index, chunks, bm25] = await Promise.all([getTextIndex(ctx.pdf), getChunks(ctx.pdf), getBm25(ctx.pdf)]);
    const strategy = contextStrategy(x);
    const nested = Boolean(panel.parentId);
    const linking = x.linkedSources || x.nestedContext || x.areaContext;
    const [xref, sections] = await Promise.all([
      linking ? getXrefIndex(ctx.pdf).catch(() => null) : null,
      x.rankingPriors || x.nestedContext ? getSections(ctx.pdf).catch(() => []) : undefined,
    ]);
    const root = nested ? rootPanelOf(ctx.panels, panel.id) : null;
    const rootPage = root ? panelPage(ctx, root) : undefined;
    const anchorHighlight = panel.anchorHighlightId ? ctx.highlights.find((h) => h.id === panel.anchorHighlightId) : undefined;
    const region = x.areaContext && !nested && panel.selectionImage ? (panel.region ?? anchorHighlight?.position.boundingRect) : undefined;
    const attached = attachmentSources(options.attachments, index);
    const input = {
      index,
      chunks,
      bm25,
      selection: panel.selection,
      pageNumber: nested ? null : (panelPage(ctx, panel) ?? null),
      inherited: panel.inheritedSources,
      attached,
      extraQuery: attachmentQuery(options.attachments),
      sections,
      refsByPage: xref?.refsByPage,
      targets: xref?.targets,
      terms: x.linkedSources || x.nestedContext ? linkTerms(ctx.glossary, index) : undefined,
      region,
      anchor: root && x.nestedContext ? rootAnchorSources(root, rootPage) : undefined,
      rootPage,
    };
    const isFirstMessage = panel.turns.length === 0;
    if (x.stableSources && !isFirstMessage && panel.baseSources?.length) {
      const { sources } = buildFollowUpSources(
        { ...input, base: panel.baseSources, question: content, leansOnSelection: isFollowUp(content) },
        strategy,
      );
      return { sources, splitAt: panel.baseSources.length };
    }
    const sources = buildDiveSources({ ...input, question: isFirstMessage ? undefined : content }, undefined, strategy);
    return { sources, splitAt: x.stableSources ? sources.length : undefined };
  } catch {
    return undefined;
  }
}

const ROOT_ANSWER_CHARS = 800;

// What the answer-shape and navigation experiments add to the prompt.
export function divePromptOptions(
  ctx: DiveRequestContext,
  panel: DivePanel,
  sources: SourceRef[] | undefined,
  options: { splitAt?: number; diagram?: boolean },
): DivePromptOptions {
  const x = ctx.experiments;
  const root = panel.parentId ? rootPanelOf(ctx.panels, panel.id) : panel;
  const rootPage = root ? panelPage(ctx, root) : undefined;
  let rootInfo: DivePromptOptions["root"];
  if (x.rootAnchor && panel.parentId && root) {
    const answer = firstAnswer(root);
    const text = answer ? markersToPages(answer.content, answer.sources ?? [], ctx.pageLabel) : "";
    rootInfo = {
      selection: root.selection || "(a selected region of the page)",
      page: rootPage !== undefined ? ctx.pageLabel(rootPage) : undefined,
      firstAnswer: text ? (text.length > ROOT_ANSWER_CHARS ? `${text.slice(0, ROOT_ANSWER_CHARS)}…` : text) : undefined,
    };
  }
  let readerNotes: string | undefined;
  if (x.readerNotes) {
    const page = rootPage ?? null;
    readerNotes =
      readerNotesBlock({
        selection: panel.selection,
        // Only the stable sources, so the prompt's prefix doesn't change
        // with each follow-up's additions.
        sources: (sources ?? []).slice(0, options.splitAt),
        pageNumber: page,
        glossary: ctx.glossary
          .filter((entry) => entry.status === "done")
          .map((entry) => ({
            term: entry.term,
            aliases: entry.aliases,
            definition:
              entry.kind === "symbol" && page !== null ? (meaningAt(entry.meanings, page)?.meaning.definition ?? entry.definition) : entry.definition,
            source: entry.source,
          })),
        highlights: ctx.highlights
          .filter((highlight) => !highlight.glossaryFlash)
          .map((highlight) => ({
            pageNumber: highlight.position.boundingRect.pageNumber,
            text: highlight.content.text ?? "",
            comment: highlight.comment ?? "",
          })),
        dives: ctx.panels
          .filter((other) => !other.parentId && other.id !== root?.id)
          .flatMap((other) => {
            const pageNumber = panelPage(ctx, other);
            if (pageNumber === undefined) return [];
            const summary = other.summary?.content.split("\n").find((line) => line.trim())?.replace(/\*\*In short:\*\*\s*/i, "");
            return [{ label: other.label, pageNumber, ...(summary ? { summary: markersToPages(summary, other.summary!.sources, ctx.pageLabel) } : {}) }];
          }),
        pageLabel: ctx.pageLabel,
      }) || undefined;
  }
  return {
    ...(x.orientationFirst ? { orientationFirst: true } : {}),
    ...(x.suggestions ? { suggestions: true } : {}),
    ...(x.diagrams ? { diagrams: true } : {}),
    ...(options.diagram ? { diagram: true } : {}),
    ...(rootInfo ? { root: rootInfo } : {}),
    ...(readerNotes ? { readerNotes } : {}),
    ...(options.splitAt !== undefined ? { splitAt: options.splitAt } : {}),
  };
}
