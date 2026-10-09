import type { TextChunk } from "../text/chunks.ts";

// Local, dependency-free relevance ranking (BM25) over the document's
// chunks — what decides which passages the model sees. See the grounded-study
// roadmap §5.2: include what's clearly relevant, stop when relevance drops
// off, and never send text "just in case".

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does doing for from had has have having he her " +
    "here hers him his how i if in into is it its itself just me more most my no nor not of off on once only or " +
    "other our ours out over own same she should so some such than that the their theirs them then there these " +
    "they this those through to too under until up very was we were what when where which while who whom why " +
    "will with would you your yours also may might must shall us via per each any both few many much let"
  ).split(" "),
);

// Plural and possessive forms fold together ("states" → "state"); nothing
// more aggressive, so distinct technical terms stay distinct.
function fold(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word);
}

export function tokenize(text: string): string[] {
  const words = text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word)).map(fold);
}

export interface Bm25Index {
  chunks: TextChunk[];
  termFrequencies: Map<string, number>[];
  documentFrequency: Map<string, number>;
  lengths: number[];
  averageLength: number;
}

const K1 = 1.2;
const B = 0.75;

export function buildBm25(chunks: TextChunk[]): Bm25Index {
  const termFrequencies = chunks.map((chunk) => {
    const counts = new Map<string, number>();
    for (const token of tokenize(chunk.text)) counts.set(token, (counts.get(token) ?? 0) + 1);
    return counts;
  });
  const documentFrequency = new Map<string, number>();
  for (const counts of termFrequencies) {
    for (const term of counts.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const lengths = termFrequencies.map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0));
  const averageLength = lengths.reduce((sum, n) => sum + n, 0) / Math.max(1, lengths.length);
  return { chunks, termFrequencies, documentFrequency, lengths, averageLength };
}

function queryTerms(index: Bm25Index, query: string): { terms: string[]; idf: number[] } {
  const terms = [...new Set(tokenize(query))];
  const total = index.chunks.length;
  const idf = terms.map((term) => {
    const df = index.documentFrequency.get(term) ?? 0;
    return Math.log(1 + (total - df + 0.5) / (df + 0.5));
  });
  return { terms, idf };
}

// One score per chunk, parallel to index.chunks. `phrases` (two-word
// phrases from the query) add a bonus to chunks containing one verbatim —
// the words together, not scattered — worth PHRASE_BONUS × their IDF.
export const PHRASE_BONUS = 0.5;

export function scoreChunks(index: Bm25Index, query: string, phrases: string[] = []): number[] {
  const { terms, idf } = queryTerms(index, query);
  const scores = index.termFrequencies.map((counts, i) => {
    const norm = K1 * (1 - B + (B * index.lengths[i]) / (index.averageLength || 1));
    let score = 0;
    terms.forEach((term, t) => {
      const tf = counts.get(term);
      if (tf) score += (idf[t] * tf * (K1 + 1)) / (tf + norm);
    });
    return score;
  });
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase().replace(/\s+/g, " ").trim();
    if (!needle) continue;
    const bonus = PHRASE_BONUS * queryTerms(index, needle).idf.reduce((sum, weight) => sum + weight, 0);
    index.chunks.forEach((chunk, i) => {
      if (scores[i] > 0 && chunk.text.toLowerCase().replace(/\s+/g, " ").includes(needle)) scores[i] += bonus;
    });
  }
  return scores;
}

export interface SelectOptions {
  // Clearly relevant chunks are added up to this many characters...
  typicalChars: number;
  // ...and beyond it, only strongly relevant ones, never past this.
  ceilingChars: number;
  exclude?: ReadonlySet<string>; // chunk ids already chosen another way
  relativeCutoff?: number; // "clearly relevant": score ≥ this × the top score
  strongCutoff?: number; // "strongly relevant", for going past typicalChars
  // Below this share of what a chunk matching every query term once would
  // score, a chunk only shares a common word or two with the query.
  // Relative, because BM25 scores shrink as a document's size and its terms'
  // frequency change.
  minFraction?: number;
  // Ranking signals (the dive experiments' rankingPriors; see priors.ts):
  // per-chunk multipliers parallel to index.chunks, two-word phrases, and
  // pages never to take from. The minFraction floor stays on the plain
  // BM25 score, so a boost can't turn a one-word overlap into a hit.
  weights?: number[];
  phrases?: string[];
  excludePages?: ReadonlySet<number>;
}

// Starting points, to tune with the grounding eval (roadmap §11).
export const DEFAULT_RELATIVE_CUTOFF = 0.4;
export const DEFAULT_STRONG_CUTOFF = 0.75;
export const DEFAULT_MIN_FRACTION = 0.2;

export interface ScoredChunk {
  chunk: TextChunk;
  score: number;
}

// The chunks worth sending for `query`, most relevant first. Empty when
// nothing in the document is relevant — the caller can then skip the model.
export function selectRelevant(index: Bm25Index, query: string, options: SelectOptions): ScoredChunk[] {
  const {
    typicalChars,
    ceilingChars,
    exclude,
    relativeCutoff = DEFAULT_RELATIVE_CUTOFF,
    strongCutoff = DEFAULT_STRONG_CUTOFF,
    minFraction = DEFAULT_MIN_FRACTION,
  } = options;
  const { weights, phrases, excludePages } = options;
  const scores = scoreChunks(index, query);
  const boosted = phrases?.length ? scoreChunks(index, query, phrases) : scores;
  const minScore = minFraction * queryTerms(index, query).idf.reduce((sum, weight) => sum + weight, 0);
  const ranked = index.chunks
    .map((chunk, i) => ({ chunk, raw: scores[i], score: boosted[i] * (weights?.[i] ?? 1) }))
    .filter(
      ({ chunk, raw, score }) =>
        raw > 0 && raw >= minScore && score > 0 && !exclude?.has(chunk.id) && !excludePages?.has(chunk.pageNumber),
    )
    .map(({ chunk, score }) => ({ chunk, score }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;

  const chosen: ScoredChunk[] = [];
  let size = 0;
  for (const candidate of ranked) {
    if (candidate.score < relativeCutoff * top) break;
    const next = size + candidate.chunk.text.length;
    const fits = next <= typicalChars || (candidate.score >= strongCutoff * top && next <= ceilingChars);
    if (!fits) continue;
    chosen.push(candidate);
    size = next;
  }
  return chosen;
}
