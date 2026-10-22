// Reference lookups for glossary terms: what a dictionary and an
// encyclopedia say about a word or phrase, from Wiktionary and Wikipedia.
// Both are free, keyless and usually answer in well under a second, so a
// lookup runs alongside the document search and its candidates go into the
// glossary's one model call — the model picks the sense that matches the
// document (or none), and the reader sees that entry verbatim, with a link.

import { decodeEntities, htmlToText } from "./mathml.js";

// Wikimedia rate-limits by how a client identifies itself: 10 requests a
// minute with no contact in the User-Agent, 200 with one (an email or a
// URL). A lookup makes two or three requests, so set REFERENCE_CONTACT in
// .env for anything beyond light use.
function userAgent(contact) {
  return `KnowbelReader/0.1 (${contact ? `${contact}; ` : ""}desktop PDF reader, glossary lookups)`;
}
const UPSTREAM_TIMEOUT_MS = 2500;
// After a 429 without a Retry-After, per Wikimedia's guidance.
const DEFAULT_BACKOFF_MS = 5000;
const CACHE_SIZE = 500;

// Beyond this a selection is a passage, not something a dictionary has.
export const MAX_REFERENCE_WORDS = 6;

const MAX_ENGLISH_SENSES = 6;
const MAX_OTHER_LANGUAGES = 2;
const MAX_OTHER_SENSES = 2;
const WIKIPEDIA_RESULTS = 3;
const MAX_EXTRACT_CHARS = 420;

// A Wiktionary sense is HTML: links, usage labels, formulas, and sometimes
// a nested list of sub-senses. The main sense is enough — as text, with
// its formulas as $…$ LaTeX (see ./mathml.js).
export function senseText(html) {
  return htmlToText(html.replace(/<(ol|ul|dl)\b[\s\S]*?<\/\1>/gi, ""));
}

// "plural of qubit", "Alternative letter-case form of zeitgeist." — a page
// that only points at another. Returns that other page's title.
const FORM_OF = /^(?:\(\w+\)\s*)?(?:[\w-]+\s+){0,3}(?:plural|form|spelling|misspelling|participle|past|singular)\s+(?:\w+\s+)?of\b/i;

export function formOfTarget(html) {
  const text = senseText(html);
  if (!text || text.length > 80 || !FORM_OF.test(text)) return null;
  // The first link is often the label's ("plural" → Appendix:Glossary);
  // the target is the first one outside a namespace.
  for (const link of html.matchAll(/<a\b[^>]*\btitle="([^"]+)"/gi)) {
    const title = decodeEntities(link[1]);
    if (!title.includes(":")) return title;
  }
  return null;
}

// A loanword's entry in another language often just repeats the term
// ("ad hoc (created for a particular purpose)" under Danish) — noise
// beside the English entry. An entry in the term's own source language
// ("to this end, for this" under Latin) is what's worth keeping.
function isEcho(sense, term) {
  const text = sense.toLowerCase();
  const key = term.toLowerCase();
  return text === key || text.startsWith(`${key} `) || text.startsWith(`${key}(`) || text.startsWith(`${key}\n`);
}

// Wiktionary's definition API answers by language code:
// { en: [{ language, partOfSpeech, definitions: [{ definition }] }], la: [...] }.
export function parseWiktionary(data, term) {
  const entries = [];
  const seen = new Set();
  const norm = (sense) => sense.toLowerCase().replace(/[.;,\s]+$/, "");
  let others = 0;
  const codes = Object.keys(data).sort((a, b) => (a === "en" ? -1 : b === "en" ? 1 : 0));
  let englishSenses = 0;
  for (const code of codes) {
    if (!Array.isArray(data[code])) continue;
    const isEnglish = code === "en";
    let languageKept = false;
    for (const usage of data[code]) {
      const cap = isEnglish ? MAX_ENGLISH_SENSES - englishSenses : MAX_OTHER_SENSES;
      if (cap <= 0) break;
      const senses = (usage.definitions ?? [])
        // A pointer ("plural of qubit") isn't a meaning; its target was
        // looked up instead (see dictionary() below).
        .filter((d) => !formOfTarget(String(d.definition ?? "")))
        .map((d) => senseText(String(d.definition ?? "")))
        .filter((s) => s && !seen.has(norm(s)) && (isEnglish || !isEcho(s, term)))
        .slice(0, cap);
      senses.forEach((s) => seen.add(norm(s)));
      if (senses.length === 0) continue;
      if (!isEnglish && !languageKept) {
        if (others >= MAX_OTHER_LANGUAGES) break;
        others += 1;
        languageKept = true;
      }
      if (isEnglish) englishSenses += senses.length;
      entries.push({ language: usage.language, partOfSpeech: usage.partOfSpeech, senses });
      if (!isEnglish) break; // one part of speech per other language
    }
  }
  return entries;
}

// Where text can be cut: outside any $…$ formula.
function outsideMath(text, index) {
  const dollars = text.slice(0, index).match(/(?<!\\)\$/g)?.length ?? 0;
  return dollars % 2 === 0;
}

// A Wikipedia intro (HTML) as text with $…$ formulas, trimmed of brackets
// that held only a pronunciation ("a qubit () or quantum bit") and cut to
// a sentence or two.
export function cleanExtract(html) {
  let out = htmlToText(html).replace(/\s*\(\s*[;,]?\s*\)/g, "");
  if (out.length > MAX_EXTRACT_CHARS) {
    let cut = out.lastIndexOf(". ", MAX_EXTRACT_CHARS);
    while (cut > 80 && !outsideMath(out, cut)) cut = out.lastIndexOf(". ", cut - 1);
    if (cut > 80) {
      out = out.slice(0, cut + 1);
    } else {
      let end = MAX_EXTRACT_CHARS;
      while (end > 0 && !outsideMath(out, end)) end = out.lastIndexOf("$", end - 1);
      out = `${out.slice(0, end).trimEnd()}…`;
    }
  }
  return out;
}

export function parseWikipedia(data) {
  const pages = data?.query?.pages ?? [];
  return [...pages]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((page) => !page.pageprops || !("disambiguation" in page.pageprops))
    .map((page) => ({ title: page.title, extract: cleanExtract(page.extract ?? ""), url: page.fullurl }))
    .filter((page) => page.extract && page.url);
}

const wiktionaryTitle = (term) => term.replace(/ /g, "_");
const wiktionaryPage = (title) => `https://en.wiktionary.org/wiki/${encodeURIComponent(wiktionaryTitle(title))}`;

export function createReferenceLookup({
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  contact = process.env.REFERENCE_CONTACT,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const headers = { "User-Agent": userAgent(contact), Accept: "application/json" };
  // While rate-limited, lookups fail fast instead of adding to the count.
  let blockedUntil = 0;

  async function getJson(url) {
    if (now() < blockedUntil) throw new Error("Rate-limited by Wikimedia; backing off.");
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
      blockedUntil = now() + (retryAfter > 0 ? retryAfter * 1000 : DEFAULT_BACKOFF_MS);
      throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return res.json();
  }

  const definitionUrl = (title) =>
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(wiktionaryTitle(title))}`;

  // Wiktionary titles are case-sensitive: "Qubit" has no page, "qubit" does.
  // Both spellings are asked for at once rather than one after the other, so
  // a capitalised selection costs one round trip; the exact one still wins.
  async function wiktionaryData(term) {
    const lower = term.toLowerCase();
    if (term === lower) return { data: await getJson(definitionUrl(term)), title: term };
    const [exact, lowered] = await Promise.allSettled([getJson(definitionUrl(term)), getJson(definitionUrl(lower))]);
    if (exact.status === "rejected") throw exact.reason;
    if (exact.value) return { data: exact.value, title: term };
    if (lowered.status === "rejected") throw lowered.reason;
    return { data: lowered.value, title: lower };
  }

  async function dictionary(term) {
    let { data, title } = await wiktionaryData(term);
    if (!data) return null;
    // "qubits" → "plural of qubit": the lemma's page is the useful one.
    // One hop only; the other languages found on the first page stay.
    const first = data.en?.[0]?.definitions?.find((d) => senseText(String(d.definition ?? "")));
    const target = first ? formOfTarget(String(first.definition)) : null;
    if (target && target !== title) {
      const lemma = await getJson(definitionUrl(target)).catch(() => null);
      if (lemma) {
        const { en: _formOf, ...otherLanguages } = data;
        data = { ...otherLanguages, ...lemma };
        title = target;
      }
    }
    const entries = parseWiktionary(data, term);
    return entries.length ? { url: wiktionaryPage(title), entries } : null;
  }

  async function encyclopedia(term) {
    const params = new URLSearchParams({
      action: "query",
      format: "json",
      formatversion: "2",
      generator: "search",
      gsrsearch: term,
      gsrlimit: String(WIKIPEDIA_RESULTS),
      prop: "extracts|pageprops|info",
      inprop: "url",
      exintro: "1",
      // HTML rather than plain text: plain text flattens a formula to its
      // rendered symbols followed by its TeX source ("P − 1 A P = D
      // {\displaystyle P^{-1}AP=D}"); the HTML has it as one <math>.
      exsentences: "2",
      exlimit: String(WIKIPEDIA_RESULTS),
      ppprop: "disambiguation",
      redirects: "1",
    });
    return parseWikipedia(await getJson(`https://en.wikipedia.org/w/api.php?${params}`));
  }

  // Either source failing (offline, rate-limited) just leaves it out;
  // a result is cached only when neither failed.
  return async function lookupReference(rawTerm) {
    const term = rawTerm.trim().replace(/\s+/g, " ");
    const key = term.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }

    const [dict, wiki] = await Promise.allSettled([dictionary(term), encyclopedia(term)]);
    const result = {
      dictionary: dict.status === "fulfilled" ? dict.value : null,
      encyclopedia: wiki.status === "fulfilled" ? wiki.value : [],
    };
    if (dict.status === "fulfilled" && wiki.status === "fulfilled") {
      cache.set(key, result);
      if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }
    return result;
  };
}
