import { sentenceBoundaries } from "../text/chunks.ts";
import { tokenize } from "./retrieval.ts";
import type { AnswerGrounding, CitationKind, SourceRef } from "./types.ts";

// Reading the citation markers out of a model's answer (see prompt.ts for
// the protocol), checking them against the sources actually sent, and
// turning them into chips. All deterministic: nothing here trusts the
// model's own account of how grounded its answer is.

// [S3] · [S3, S7] · [inferred: S3] · [general] · [not-covered]
const MARKER =
  /\[\s*(?:(inferred)\s*:?\s*)?(S\d+(?:\s*,\s*S\d+)*)\s*\]|\[\s*(general)\s*\]|\[\s*(not[- ]covered)\s*\]/gi;

export interface CitationGroup {
  start: number; // [start, end) of the marker(s) in the answer text
  end: number;
  kind: CitationKind | "unverified"; // unverified: cited only ids that weren't sent
  labels: string[]; // cited ids that were sent
  claim: string; // the text the citation is attached to
  quoteMissing: boolean; // quoted "…" text that isn't in the cited sources
}

export interface ParsedAnswer {
  notCovered: boolean;
  groups: CitationGroup[];
  markers: [number, number][]; // every marker's range, [not-covered] included
}

// The sentence (or sentence fragment) a marker at `at` closes: back to the
// previous marker or sentence end.
function claimBefore(text: string, from: number, at: number): string {
  const span = text.slice(from, at);
  const pieces = span.split(/(?<=[.!?])\s+(?=\S)/);
  // A marker right after a sentence's full stop cites that sentence, not the
  // (empty) one after it.
  let claim = pieces[pieces.length - 1];
  if (!claim.trim() && pieces.length > 1) claim = pieces[pieces.length - 2];
  return claim.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
}

const normalize = (value: string) =>
  value
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

// Quoted text at the end of a claim must be in a cited source — verbatim,
// or with at least 90% of its words present (extraction differences).
function quoteFound(claim: string, sources: SourceRef[]): boolean {
  const quoted = /["“]([^"“”]{12,})["”][.,;:!?)]*\s*$/.exec(claim)?.[1];
  if (!quoted) return true;
  const needle = normalize(quoted);
  return sources.some((source) => {
    const hay = normalize(source.text);
    if (hay.includes(needle)) return true;
    const words = tokenize(needle);
    if (words.length === 0) return false;
    const present = new Set(tokenize(hay));
    return words.filter((word) => present.has(word)).length / words.length >= 0.9;
  });
}

export function parseAnswer(text: string, sources: SourceRef[]): ParsedAnswer {
  const byLabel = new Map(sources.map((source) => [source.label.toUpperCase(), source]));
  const groups: CitationGroup[] = [];
  const markers: [number, number][] = [];
  let notCovered = false;
  let claimFrom = 0;

  for (const match of text.matchAll(MARKER)) {
    const start = match.index;
    const end = start + match[0].length;
    markers.push([start, end]);
    if (match[4]) {
      if (!text.slice(0, start).trim()) notCovered = true;
      claimFrom = end;
      continue;
    }

    let kind: CitationGroup["kind"] = match[3] ? "general" : match[1] ? "inferred" : "stated";
    const cited = match[2] ? match[2].split(",").map((id) => id.trim().toUpperCase()) : [];
    const labels = cited.filter((id) => byLabel.has(id));
    if (kind !== "general" && labels.length === 0) kind = "unverified";

    // [S3][S7], or [S3] [S7]: one chip.
    const previous = groups[groups.length - 1];
    if (previous && previous.kind === kind && !text.slice(previous.end, start).trim()) {
      previous.end = end;
      previous.labels = [...new Set([...previous.labels, ...labels])];
      previous.quoteMissing = !quoteFound(previous.claim, previous.labels.map((id) => byLabel.get(id)!));
      claimFrom = end;
      continue;
    }

    const claim = claimBefore(text, claimFrom, start);
    const citedSources = labels.map((id) => byLabel.get(id)!);
    groups.push({
      start,
      end,
      kind,
      labels,
      claim,
      quoteMissing: kind === "stated" || kind === "inferred" ? !quoteFound(claim, citedSources) : false,
    });
    claimFrom = end;
  }
  return { notCovered, groups, markers };
}

export function answerGrounding(parsed: ParsedAnswer): AnswerGrounding {
  if (parsed.notCovered) return "not-covered";
  const count = (kind: CitationGroup["kind"]) => parsed.groups.filter((group) => group.kind === kind).length;
  const fromDocument = count("stated") + count("inferred");
  if (fromDocument === 0) return "general";
  if (count("general") > 0 || count("unverified") > 0 || parsed.groups.some((group) => group.quoteMissing)) {
    return "mixed";
  }
  return count("inferred") > 0 ? "inferred" : "document";
}

// The sentence of `source` that best supports `claim`, as [start, end) in
// page-text offsets — what a citation's jump flashes. The whole source when
// no sentence clearly matches (common for formulas, whose words don't
// overlap much).
export function localizeClaim(claim: string, source: SourceRef): [number, number] {
  const claimWords = new Set(tokenize(claim));
  if (claimWords.size === 0) return [source.start, source.end];
  const cuts = [0, ...sentenceBoundaries(source.text), source.text.length];
  let best: [number, number] = [source.start, source.end];
  let bestScore = 0;
  for (let i = 0; i < cuts.length - 1; i += 1) {
    const sentence = source.text.slice(cuts[i], cuts[i + 1]);
    const words = new Set(tokenize(sentence));
    let shared = 0;
    for (const word of claimWords) if (words.has(word)) shared += 1;
    const score = shared / claimWords.size;
    if (score > bestScore) {
      bestScore = score;
      const trimmedEnd = cuts[i] + sentence.trimEnd().length;
      best = [source.start + cuts[i], source.start + trimmedEnd];
    }
  }
  return bestScore >= 0.2 ? best : [source.start, source.end];
}

// ---- Rendering ---------------------------------------------------------

// A chip's link target: "#cite:<turn>:<kind>[!]:<label>.<start>.<end>,…"
// — everything the chip needs to show and jump, with the flash range
// already localized. "!" marks a quote not found in the sources.
export interface ChipTarget {
  turnIndex: number;
  kind: CitationGroup["kind"];
  quoteMissing: boolean;
  refs: { label: string; start: number; end: number }[];
}

export function encodeChipTarget(target: ChipTarget): string {
  const refs = target.refs.map((ref) => `${ref.label}.${ref.start}.${ref.end}`).join(",");
  return `#cite:${target.turnIndex}:${target.kind}${target.quoteMissing ? "!" : ""}:${refs}`;
}

export function decodeChipTarget(href: string): ChipTarget | null {
  const match = /^#cite:(\d+):(stated|inferred|general|unverified)(!?):(.*)$/.exec(href);
  if (!match) return null;
  const refs = match[4]
    ? match[4].split(",").flatMap((part) => {
        const [label, start, end] = part.split(".");
        const s = Number(start);
        const e = Number(end);
        return label && Number.isFinite(s) && Number.isFinite(e) ? [{ label, start: s, end: e }] : [];
      })
    : [];
  return { turnIndex: Number(match[1]), kind: match[2] as ChipTarget["kind"], quoteMissing: match[3] === "!", refs };
}

// "p. 42" · "pp. 42, 45" — the chip's text, in the book's own page labels.
export function chipLabel(kind: CitationGroup["kind"], pages: string[]): string {
  if (kind === "general") return "general";
  if (kind === "unverified") return "unverified";
  const unique = [...new Set(pages)];
  return `${unique.length > 1 ? "pp." : "p."} ${unique.join(", ")}`;
}

// The answer with each citation group replaced by a chip — an empty
// markdown link, `[](#cite:… "p. 42")`. Empty so the chip adds no text to
// the rendered markdown (dive selections and highlights count characters in
// it); its label is drawn from the title by CSS. [not-covered] is dropped:
// the answer's badge says it.
export function toChipMarkdown(
  text: string,
  sources: SourceRef[],
  turnIndex: number,
  pageLabel: (pageNumber: number) => string,
): string {
  const parsed = parseAnswer(text, sources);
  const byLabel = new Map(sources.map((source) => [source.label.toUpperCase(), source]));
  const replacements = new Map<number, { end: number; value: string }>();
  for (const [start, end] of parsed.markers) replacements.set(start, { end, value: "" });
  for (const group of parsed.groups) {
    const cited = group.labels.map((label) => byLabel.get(label)!);
    const target = encodeChipTarget({
      turnIndex,
      kind: group.kind,
      quoteMissing: group.quoteMissing,
      refs: cited.map((source) => {
        const [start, end] = localizeClaim(group.claim, source);
        return { label: source.label, start, end };
      }),
    });
    const title = chipLabel(group.kind, cited.map((source) => pageLabel(source.pageNumber))).replace(/"/g, "'");
    // Covers every marker the group merged.
    for (const [start] of parsed.markers) if (start > group.start && start < group.end) replacements.delete(start);
    replacements.set(group.start, { end: group.end, value: `[](${target} "${title}")` });
  }

  let out = "";
  let at = 0;
  for (const start of [...replacements.keys()].sort((a, b) => a - b)) {
    const { end, value } = replacements.get(start)!;
    // "claim [S1]." → "claim" + chip + ".": the chip's own margin is the gap,
    // so the rendered (and copied) text has no stray space before the period.
    const before = text.slice(at, start);
    out += (value ? before.replace(/[ \t]+$/, "") : before) + value;
    at = end;
  }
  return (
    (out + text.slice(at))
      .replace(/^\s+/, "")
      // A citation left at the start of its own line — after an equation the
      // math normalizer moved onto a line of its own — keeps its chip but not
      // the sentence's orphaned full stop ("p. 20 .").
      .replace(/(^|\n)(\s*(?:\[\]\(#cite:[^)]*\))+)[.,;:]+[ \t]*(?=\n|$)/g, "$1$2")
  );
}

// For re-sending an earlier answer as conversation history: its markers
// pointed at that request's source ids, which mean something else now, so
// they become plain page references.
export function markersToPages(text: string, sources: SourceRef[], pageLabel: (pageNumber: number) => string): string {
  const byLabel = new Map(sources.map((source) => [source.label.toUpperCase(), source]));
  return text
    .replace(MARKER, (_match, _inferred, ids: string | undefined) => {
      if (!ids) return "";
      const pages = ids
        .split(",")
        .map((id) => byLabel.get(id.trim().toUpperCase()))
        .filter((source): source is SourceRef => Boolean(source))
        .map((source) => pageLabel(source.pageNumber));
      return pages.length ? ` (${chipLabel("stated", pages)})` : "";
    })
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// While a reply streams in, a marker arrives a few characters at a time;
// hide a trailing partial one ("[S", "[infer") until it's complete, so raw
// brackets never flash on screen.
export function trimPartialMarker(text: string): string {
  const open = text.lastIndexOf("[");
  if (open === -1 || text.indexOf("]", open) !== -1 || text.length - open > 40) return text;
  const tail = text.slice(open).toLowerCase().replace(/\s+/g, "");
  const partial =
    /^\[(inferred:?)?(s\d*(,s?\d*)*)?$/.test(tail) ||
    "[inferred:".startsWith(tail) ||
    "[general]".startsWith(tail) ||
    "[not-covered]".startsWith(tail);
  return partial ? text.slice(0, open) : text;
}

// The sources an answer actually cited — what a nested dive inherits and
// what the sources footer lists.
export function citedSources(text: string, sources: SourceRef[]): SourceRef[] {
  const cited = new Set(parseAnswer(text, sources).groups.flatMap((group) => group.labels));
  return sources.filter((source) => cited.has(source.label.toUpperCase()));
}
