// The grounding eval (roadmap §11): runs real questions against real PDFs
// through the app's own context builder, prompt, provider and citation
// parser, and measures what the reader would get — are the right passages
// sent, are claims cited, do citations resolve, is "not covered" honest, and
// what does it cost. Bundled and run by scripts/eval-grounding.mjs.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PdfExtractedPage } from "react-pdf-highlighter-plus";
import { buildTextIndex, findTextMatches, type DocumentTextIndex } from "../../src/glossary/textIndex";
import { chunkDocument } from "../../src/text/chunks";
import { answerGrounding, parseAnswer } from "../../src/grounding/citations";
import { buildAskSystem, selectAskSources } from "../../src/grounding/ask";
import { buildDiveSources } from "../../src/grounding/context";
import { collectTargets, findPageRefs, type XrefRef, type XrefTargets } from "../../src/xref/detect";
import { buildSections, type OutlineSource, type Section } from "../../src/text/sections";
import { contextStrategy, DEFAULT_EXPERIMENTS, type DiveExperiments } from "../../src/deepdive/experiments";
import { splitSuggestions } from "../../src/deepdive/suggestions";
import { buildBm25, type Bm25Index } from "../../src/grounding/retrieval";
import type { SourceRef } from "../../src/grounding/types";
import { buildDivePrompt, openingMessage } from "../../src/deepdive/prompts";
import type { DivePanel } from "../../src/deepdive/types";
// @ts-expect-error — plain JS server modules
import { createProvider } from "../../server/providers/index.js";
// @ts-expect-error — plain JS server modules
import { roleConfig } from "../../server/models.js";

export interface EvalQuestion {
  id: string;
  question?: string; // an Ask-style question
  selection?: string; // a Deep Dive selection (dive mode); `question` then is an optional follow-up
  goldPages?: number[]; // pages holding the answer
  notCovered?: boolean; // the document doesn't answer this
}

export interface EvalCorpus {
  documents: { pdf: string; questions: EvalQuestion[] }[];
}

export interface EvalOptions {
  corpusPath: string;
  // Deep Dive experiments to run the dive cases with (deepdive/experiments.ts);
  // none — the default — is the standard dive.
  experiments?: Partial<DiveExperiments>;
  // Run once with no experiments, then once with each context experiment
  // alone, and compare (retrieval only makes sense with --dry).
  each?: boolean;
  dry: boolean; // retrieval only, no model calls
  judge: boolean; // LLM-judge each cited claim against its source
  out: string;
}

// ---- PDF text, the way the app extracts it -----------------------------------

async function extractPages(file: string): Promise<{ pages: PdfExtractedPage[]; title: string; sections: Section[] }> {
  const data = new Uint8Array(await readFile(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true }).promise;
  const pages: PdfExtractedPage[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const textItems = content.items.flatMap((item, index) => {
      if (!("str" in item) || !item.str) return [];
      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]);
      return [
        {
          text: item.str,
          index,
          pageNumber: n,
          rect: { left: tx[4], top: tx[5] - height, width: item.width * viewport.scale, height, pageNumber: n },
        },
      ];
    });
    pages.push({ pageNumber: n, width: viewport.width, height: viewport.height, textItems });
  }
  const sections = await buildSections(doc as unknown as OutlineSource).catch(() => []);
  return { pages, title: path.basename(file), sections };
}

// ---- One question ---------------------------------------------------------------

interface Document {
  title: string;
  index: DocumentTextIndex;
  chunks: ReturnType<typeof chunkDocument>;
  bm25: Bm25Index;
  sections: Section[];
  // Cross-references from the text alone (the app also reads the PDF's own
  // link annotations).
  targets: XrefTargets;
  refsByPage: Map<number, XrefRef[]>;
}

function selectionPage(doc: Document, selection: string): number | null {
  const probe = selection.replace(/\s+/g, " ").trim().slice(0, 60);
  return findTextMatches(doc.index, probe)[0]?.page.pageNumber ?? null;
}

function buildRequest(doc: Document, q: EvalQuestion, experiments: DiveExperiments) {
  const pageLabel = (n: number) => String(n);
  if (q.selection) {
    const pageNumber = selectionPage(doc, q.selection);
    const sources = buildDiveSources(
      { ...doc, selection: q.selection, pageNumber, question: q.question },
      undefined,
      contextStrategy(experiments),
    );
    const panel: DivePanel = {
      id: q.id,
      parentId: null,
      anchorHighlightId: null,
      selection: q.selection,
      label: q.selection.slice(0, 60),
      contextText: "",
      turns: [],
      createdAt: "",
    };
    const { system } = buildDivePrompt(doc.title, panel, null, { sources, pageLabel }, {
      ...(experiments.orientationFirst ? { orientationFirst: true } : {}),
      ...(experiments.suggestions ? { suggestions: true } : {}),
    });
    const messages = [{ role: "user", content: openingMessage(q.selection) }];
    if (q.question) messages.push({ role: "assistant", content: "(earlier explanation)" }, { role: "user", content: q.question });
    return { sources, system, messages };
  }
  // The Ask panel's own selection and prompt (whole document, as a question
  // with no page or chapter named would be).
  const { sources, basis } = selectAskSources({ chunks: doc.chunks, bm25: doc.bm25, question: q.question ?? "", scope: { kind: "document" } });
  const system = buildAskSystem({ fileName: doc.title, scope: { kind: "document" }, basis, sources, generalAllowed: false, pageLabel });
  return { sources, system, messages: [{ role: "user", content: q.question ?? "" }] };
}

// Sentences carrying a claim marker, of all sentences with real content.
function citationCoverage(answer: string): number {
  const sentences = answer
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z\d"(])/)
    .filter((sentence) => sentence.replace(/\[[^\]]*\]/g, "").trim().split(/\s+/).length >= 4);
  if (sentences.length === 0) return 1;
  const cited = sentences.filter((sentence) => /\[(?:inferred\s*:?\s*)?S\d+|\[general\]/i.test(sentence));
  return cited.length / sentences.length;
}

interface Usage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

async function judgeClaims(
  judge: { complete: (args: { system: string; prompt: string }) => Promise<string> },
  answer: string,
  sources: SourceRef[],
): Promise<{ checked: number; supported: number }> {
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  let checked = 0;
  let supported = 0;
  for (const group of parseAnswer(answer, sources).groups) {
    if (group.kind !== "stated" && group.kind !== "inferred") continue;
    const passages = group.labels.map((label) => byLabel.get(label)?.text ?? "").join("\n---\n");
    const verdict = await judge.complete({
      system:
        "You check citations. Reply with exactly one word: YES if the passage supports the claim (for an inferred claim: if it follows from the passage), otherwise NO.",
      prompt: `Claim (${group.kind}): ${group.claim}\n\nPassage:\n${passages}`,
    });
    checked += 1;
    if (/^\s*yes/i.test(verdict)) supported += 1;
  }
  return { checked, supported };
}

// "--experiments localWindow,suggestions" or "--experiments all".
export function experimentsFromArg(arg: string): Partial<DiveExperiments> {
  const names = arg.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.includes("all")) return Object.fromEntries(Object.keys(DEFAULT_EXPERIMENTS).map((key) => [key, true]));
  const unknown = names.filter((name) => !(name in DEFAULT_EXPERIMENTS));
  if (unknown.length) throw new Error(`Unknown experiments: ${unknown.join(", ")}. Known: ${Object.keys(DEFAULT_EXPERIMENTS).join(", ")}`);
  return Object.fromEntries(names.map((name) => [name, true]));
}

const CONTEXT_EXPERIMENTS: (keyof DiveExperiments)[] = ["localWindow", "linkedSources", "rankingPriors", "areaContext", "nestedContext"];

export async function runEval(options: EvalOptions) {
  if (!options.each) {
    const experiments = { ...DEFAULT_EXPERIMENTS, ...options.experiments };
    const { summary, results } = await runOnce(options, experiments);
    await writeFile(options.out, JSON.stringify({ experiments, summary, results }, null, 2));
    console.log(`Wrote ${options.out}`);
    return;
  }
  const runs = [];
  for (const flag of [null, ...CONTEXT_EXPERIMENTS]) {
    const experiments = { ...DEFAULT_EXPERIMENTS, ...(flag ? { [flag]: true } : {}) };
    console.log(`\n=== ${flag ?? "baseline"} ===`);
    runs.push({ name: flag ?? "baseline", experiments, ...(await runOnce(options, experiments)) });
  }
  console.log("\nComparison");
  console.table(
    Object.fromEntries(
      runs.map((run) => [
        run.name,
        {
          goldInSources: run.summary.goldInSources,
          goldRecall: run.summary.goldRecall,
          medianSourceChars: run.summary.medianSourceChars,
          ...(options.dry ? {} : { goldCited: run.summary.goldCited, medianInputTokens: run.summary.medianInputTokens }),
        },
      ]),
    ),
  );
  await writeFile(options.out, JSON.stringify({ runs }, null, 2));
  console.log(`Wrote ${options.out}`);
}

async function runOnce(options: EvalOptions, experiments: DiveExperiments) {
  const corpus = JSON.parse(await readFile(options.corpusPath, "utf8")) as EvalCorpus;
  const base = path.dirname(path.resolve(options.corpusPath));
  const answerer = options.dry ? null : (() => {
    const { provider, ...config } = roleConfig("DIVE");
    return createProvider(provider, config);
  })();
  const judge = options.judge && !options.dry ? (() => {
    const { provider, ...config } = roleConfig("QUICK");
    return createProvider(provider, config);
  })() : null;

  const results = [];
  for (const entry of corpus.documents) {
    const { pages, title, sections } = await extractPages(path.resolve(base, entry.pdf));
    const index = buildTextIndex(pages);
    const chunks = chunkDocument(index);
    const targets = collectTargets(index.pages, sections);
    const refsByPage = new Map(index.pages.map((page) => [page.pageNumber, findPageRefs(page, targets)] as const));
    const doc: Document = { title, index, chunks, bm25: buildBm25(chunks), sections, targets, refsByPage };

    for (const q of entry.questions) {
      const { sources, system, messages } = buildRequest(doc, q, experiments);
      const sourcePages = [...new Set(sources.map((source) => source.pageNumber))];
      const via: Record<string, number> = {};
      for (const source of sources) via[source.via ?? "other"] = (via[source.via ?? "other"] ?? 0) + 1;
      const result: Record<string, unknown> = {
        document: entry.pdf,
        id: q.id,
        mode: q.selection ? "dive" : "ask",
        sources: sources.length,
        sourceChars: sources.reduce((sum, source) => sum + source.text.length, 0),
        systemChars: system.length,
        goldInSources: q.goldPages?.length ? q.goldPages.some((p) => sourcePages.includes(p)) : null,
        // The share of gold pages covered, not just any one.
        goldRecall: q.goldPages?.length
          ? Number((q.goldPages.filter((p) => sourcePages.includes(p)).length / q.goldPages.length).toFixed(2))
          : null,
        via,
      };
      if (answerer && !q.selection && sources.length === 0) {
        // Nothing relevant: the reader is told so without a model call.
        Object.assign(result, {
          grounding: "not-covered",
          skippedModel: true,
          notCoveredCorrect: q.notCovered === undefined ? null : q.notCovered === true,
          usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
        });
      } else if (answerer) {
        let usage: Usage | null = null;
        const reply: string = await answerer.streamReply({ system, messages, onText: () => {}, onUsage: (u: Usage) => (usage = u) });
        const { body: answer, suggestions } = experiments.suggestions ? splitSuggestions(reply) : { body: reply, suggestions: [] };
        const parsed = parseAnswer(answer, sources);
        const grounding = answerGrounding(parsed);
        const citedPages = new Set(
          parsed.groups.flatMap((group) => group.labels).map((label) => sources.find((s) => s.label === label)?.pageNumber),
        );
        Object.assign(result, {
          answer,
          ...(experiments.suggestions ? { suggestions } : {}),
          grounding,
          words: answer.replace(/\[[^\]]*\]/g, "").split(/\s+/).filter(Boolean).length,
          citations: parsed.groups.length,
          unverifiedCitations: parsed.groups.filter((group) => group.kind === "unverified").length,
          quotesMissing: parsed.groups.filter((group) => group.quoteMissing).length,
          coverage: Number(citationCoverage(answer).toFixed(2)),
          goldCited: q.goldPages?.length ? q.goldPages.some((p) => citedPages.has(p)) : null,
          notCoveredCorrect: q.notCovered === undefined ? null : (grounding === "not-covered") === q.notCovered,
          usage,
        });
        if (judge) result.judge = await judgeClaims(judge, answer, sources);
      }
      results.push(result);
      console.log(
        `${q.id.padEnd(10)} ${String(result.mode).padEnd(4)} src=${result.sources} (${result.sourceChars} ch)` +
          (result.goldInSources === null ? "" : ` gold-in-src=${result.goldInSources ? "✓" : "✗"}`) +
          (answerer
            ? ` ${result.grounding} cov=${result.coverage} words=${result.words}` +
              (result.goldCited === null ? "" : ` gold-cited=${result.goldCited ? "✓" : "✗"}`) +
              (result.notCoveredCorrect === null ? "" : ` not-covered=${result.notCoveredCorrect ? "✓" : "✗"}`)
            : ""),
      );
    }
  }

  const rate = (key: string) => {
    const values = results.map((r) => r[key]).filter((v) => typeof v === "boolean");
    return values.length ? `${Math.round((100 * values.filter(Boolean).length) / values.length)}% (${values.length})` : "—";
  };
  const median = (values: number[]) => {
    if (values.length === 0) return "—";
    const sorted = [...values].sort((a, b) => a - b);
    return String(sorted[Math.floor(sorted.length / 2)]);
  };
  const judged = results.map((r) => r.judge as { checked: number; supported: number } | undefined).filter(Boolean);
  const recalls = results.map((r) => r.goldRecall).filter((v): v is number => typeof v === "number");
  const summary = {
    questions: results.length,
    goldInSources: rate("goldInSources"),
    goldRecall: recalls.length ? Number((recalls.reduce((a, b) => a + b, 0) / recalls.length).toFixed(2)) : "—",
    goldCited: rate("goldCited"),
    notCoveredCorrect: rate("notCoveredCorrect"),
    unverifiedCitations: results.reduce((sum, r) => sum + ((r.unverifiedCitations as number) ?? 0), 0),
    medianCoverage: median(results.map((r) => r.coverage as number).filter((v) => typeof v === "number")),
    medianWords: median(results.map((r) => r.words as number).filter((v) => typeof v === "number")),
    medianInputTokens: median(results.map((r) => (r.usage as Usage | null)?.inputTokens).filter((v): v is number => typeof v === "number")),
    medianSourceChars: median(results.map((r) => r.sourceChars as number)),
    supportedClaims: judged.length
      ? `${Math.round((100 * judged.reduce((s, j) => s + j!.supported, 0)) / Math.max(1, judged.reduce((s, j) => s + j!.checked, 0)))}%`
      : "—",
  };
  console.log("\nSummary", summary);
  return { summary, results };
}
