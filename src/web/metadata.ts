import { normalizeText } from "./html.ts";
import type { PageMetadata } from "./types.ts";

// What a page says about itself — title, authors, site, dates — gathered
// from every place pages put it: <meta> tags (Open Graph, Twitter, Dublin
// Core, Highwire "citation_*"), JSON-LD structured data, and, since plenty
// of pages carry none of that, what's printed around the title ("By …",
// "Authors: …", "Oct 14, 2026"). Runs on the page as fetched, before
// anything is taken out of it.

const ARTICLE_TYPES = /^(Article|NewsArticle|BlogPosting|TechArticle|ScholarlyArticle|Report|AnalysisNewsArticle|OpinionNewsArticle|ReportageNewsArticle|LiveBlogPosting|SocialMediaPosting|WebPage|HowTo|Course|Chapter|Book)$/i;

interface JsonLd {
  headline?: string;
  authors: { name: string; person: boolean }[];
  datePublished?: string;
  dateModified?: string;
  publisher?: string;
  description?: string;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function readJsonLd(doc: Document): JsonLd {
  const found: JsonLd = { authors: [] };
  const nodes: Record<string, unknown>[] = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse((script.textContent ?? "").replace(/^\s*<!--|-->\s*$/g, ""));
      for (const item of asArray(data)) {
        if (!item || typeof item !== "object") continue;
        nodes.push(item as Record<string, unknown>);
        for (const inner of asArray((item as { "@graph"?: unknown })["@graph"])) {
          if (inner && typeof inner === "object") nodes.push(inner as Record<string, unknown>);
        }
      }
    } catch {
      // Malformed structured data is common; the rest still counts.
    }
  }
  const types = (node: Record<string, unknown>) => asArray(node["@type"] as string | string[]).map(String);
  const article = nodes.find((node) => types(node).some((type) => ARTICLE_TYPES.test(type) && !/^WebPage$/i.test(type))) ??
    nodes.find((node) => types(node).some((type) => ARTICLE_TYPES.test(type)));
  if (!article) return found;
  const text = (value: unknown) => (typeof value === "string" ? normalizeText(value) : undefined);
  found.headline = text(article.headline) ?? text(article.name);
  found.description = text(article.description);
  found.datePublished = text(article.datePublished) ?? text(article.dateCreated);
  found.dateModified = text(article.dateModified);
  const publisher = article.publisher as { name?: unknown } | undefined;
  found.publisher = text(publisher?.name);
  for (const author of asArray(article.author as unknown)) {
    if (typeof author === "string") {
      found.authors.push({ name: normalizeText(author), person: true });
    } else if (author && typeof author === "object") {
      const name = text((author as { name?: unknown }).name);
      const isOrg = asArray((author as { "@type"?: string | string[] })["@type"]).some((t) => /Organization/i.test(String(t)));
      if (name) found.authors.push({ name, person: !isOrg });
    }
  }
  return found;
}

function metaContent(doc: Document, ...keys: string[]): string | undefined {
  for (const key of keys) {
    for (const attr of ["property", "name", "itemprop"]) {
      for (const el of doc.querySelectorAll(`meta[${attr}]`)) {
        if (el.getAttribute(attr)?.toLowerCase() !== key.toLowerCase()) continue;
        const value = normalizeText(el.getAttribute("content"));
        if (value) return value;
      }
    }
  }
  return undefined;
}

function metaContents(doc: Document, key: string): string[] {
  return [...doc.querySelectorAll("meta[name], meta[property]")]
    .filter((el) => (el.getAttribute("name") ?? el.getAttribute("property"))?.toLowerCase() === key)
    .map((el) => normalizeText(el.getAttribute("content")))
    .filter(Boolean);
}

// ---- Names ------------------------------------------------------------------------

const BYLINE_LABEL = /^(?:by|authors?|written by|posted by|words by|story by)\s*[:\-–—]?\s+/i;

// "By Ada Lovelace and Charles Babbage." → ["Ada Lovelace", "Charles Babbage"]
export function splitNames(text: string): string[] {
  const cleaned = normalizeText(text).replace(BYLINE_LABEL, "").replace(/[.;]+$/, "");
  return [
    ...new Set(
      cleaned
        .split(/\s*(?:,|&|\band\b|\bwith\b|\|)\s*/i)
        .map((name) => name.trim())
        .filter((name) => name.length >= 2 && name.length <= 60 && /\p{L}/u.test(name) && !/^https?:/i.test(name)),
    ),
  ];
}

function looksLikeNames(names: string[]): boolean {
  // Capitalised words, a few of them: "Lance Martin", not "default, the tool".
  return (
    names.length > 0 &&
    names.every((name) => name.split(/\s+/).length <= 5 && /^\p{Lu}/u.test(name) && !/[!?]/.test(name))
  );
}

// ---- Dates ------------------------------------------------------------------------

const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const PRINTED_DATE = new RegExp(
  `\\b(?:(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})\\b`,
  "i",
);

// A date as the page prints it, as YYYY-MM-DD — or null.
export function parsePrintedDate(text: string): string | null {
  const match = text.match(PRINTED_DATE);
  if (!match) return null;
  const value = match[0].replace(/(\d)(st|nd|rd|th)/i, "$1").replace(/sept/i, "sep");
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const time = Date.parse(`${value} 12:00 UTC`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function isoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // A bare date ("2017/06/12", "2017-6-1") is a day, not midnight somewhere.
  const day = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (day) return `${day[1]}-${day[2].padStart(2, "0")}-${day[3].padStart(2, "0")}`;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return parsePrintedDate(value) ?? undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date(time).toISOString();
}

// ---- Title ------------------------------------------------------------------------

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}

function overlap(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

const TITLE_SEPARATOR = /\s+[|–—·•»:\\/-]\s+/;

// "Post title | Site" → "Post title"
function cleanDocumentTitle(title: string, siteName?: string): string {
  const parts = title.split(TITLE_SEPARATOR);
  if (parts.length < 2) return title;
  const site = siteName?.toLowerCase();
  const kept = parts.filter((part) => part.toLowerCase() !== site);
  if (kept.length !== parts.length) return kept.join(" – ");
  // The longest part is the title more often than not.
  return [...parts].sort((a, b) => b.length - a.length)[0];
}

function contentRoot(doc: Document): Element {
  return doc.querySelector("main article, article, main, [role=main]") ?? doc.body ?? doc.documentElement;
}

function idOf(el: Element | null | undefined): string | undefined {
  return el?.getAttribute("data-kr-id") ?? undefined;
}

// The block a title sits in, where a byline, date and subtitle would be:
// its <header>, or failing that a couple of levels up.
function headerOf(title: Element): Element {
  const header = title.closest("header, hgroup");
  if (header && header !== title.ownerDocument.body && normalizeText(header.textContent).length < 1500) return header;
  let block: Element = title;
  for (let i = 0; i < 3 && block.parentElement && block.parentElement !== title.ownerDocument.body; i += 1) {
    const parent = block.parentElement;
    if (normalizeText(parent.textContent).length > 1500) break;
    block = parent;
  }
  return block;
}

function shortTexts(root: Element, maxLength: number): { el: Element; text: string }[] {
  const out: { el: Element; text: string }[] = [];
  for (const el of root.querySelectorAll("p, span, div, a, address, li, time, small, strong, em, h2, h3, h4, h5, h6, dd")) {
    const text = normalizeText(el.textContent);
    if (text && text.length <= maxLength) out.push({ el, text });
  }
  return out;
}

// Names marked up as the authors': each author's <address> (the element for
// an article's author), rel=author link or itemprop=author — all of them,
// for an article with several — or a byline element.
function markedAuthors(root: Element, loose: boolean): string[] {
  const names: string[] = [];
  const strict = '[rel="author"], [itemprop="author"], address';
  const selector = loose ? `${strict}, [class*="byline" i], [class*="author" i]:not([class*="authority" i])` : strict;
  for (const el of [...root.querySelectorAll(selector)].slice(0, 12)) {
    if (el.parentElement?.closest(selector)) continue; // counted with its container
    const text = normalizeText(el.textContent);
    if (!text || text.length > 160) continue;
    const found = splitNames(text);
    if (looksLikeNames(found)) names.push(...found);
    else if (loose && names.length === 0) continue;
  }
  return [...new Set(names)];
}

function bylineIn(root: Element, labelledOnly: boolean): string[] {
  const marked = markedAuthors(root, !labelledOnly);
  if (marked.length) return marked;
  // Printed as one: "By …", "Authors: …", "Written by …" — up to the end of
  // that sentence ("Written by A and B. Thanks to C…"), initials aside.
  for (const { text } of shortTexts(root, 400)) {
    if (!BYLINE_LABEL.test(text)) continue;
    if (labelledOnly && !/^(written by|authors?\s*:)/i.test(text)) continue;
    const sentence = text.match(/^(.+?)(?:\.\s+(?=\p{Lu}\p{Ll}+\s+\p{Ll})|$)/u)?.[1] ?? text;
    if (sentence.length > 200) continue;
    const names = splitNames(sentence);
    if (looksLikeNames(names)) return names;
  }
  return [];
}

export function readMetadata(doc: Document, finalUrl: string): PageMetadata {
  const ld = readJsonLd(doc);
  const host = (() => {
    try {
      return new URL(finalUrl).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();

  const documentTitle = normalizeText(doc.querySelector("title")?.textContent);
  // "Bayes' theorem - Wikipedia": a short last part of the window title is
  // usually the site's name.
  const titleSuffix = (() => {
    const parts = documentTitle.split(TITLE_SEPARATOR);
    const last = parts.length > 1 ? parts[parts.length - 1] : "";
    return last.length >= 2 && last.length <= 40 ? last : undefined;
  })();
  const siteName =
    metaContent(doc, "og:site_name", "application-name", "citation_journal_title", "citation_conference_title") ??
    titleSuffix ??
    ld.publisher ??
    (host || undefined);

  // ---- Title: the heading the page shows, when it agrees with the metadata.
  const declared = metaContent(doc, "citation_title", "og:title", "twitter:title", "dc.title") ?? ld.headline;
  const root = contentRoot(doc);
  // The heading shown as the title is the one that agrees with the title
  // the page declares — an <h1>, or failing that an <h2> (some sites keep
  // their own name in the <h1>). With nothing declared, a lone <h1> in the
  // content will do.
  const headings = (selector: string) =>
    [...doc.querySelectorAll(selector)].filter((h) => {
      const text = normalizeText(h.textContent);
      return text.length > 0 && text.length <= 300;
    });
  const reference = declared ?? (documentTitle ? cleanDocumentTitle(documentTitle, siteName) : "");
  // Pages often declare different titles in different places (a shorter
  // one for social cards): the heading may agree with any of them.
  const references = [
    ...new Set(
      [
        metaContent(doc, "citation_title"),
        metaContent(doc, "og:title"),
        metaContent(doc, "twitter:title"),
        ld.headline,
        documentTitle ? cleanDocumentTitle(documentTitle, siteName) : undefined,
      ].filter((value): value is string => !!value),
    ),
  ];
  const matching = (list: Element[]) =>
    list.find((h) => references.some((ref) => overlap(normalizeText(h.textContent), ref) >= 0.6)) ?? null;
  const h1s = headings("h1");
  const inContent = h1s.filter((h) => root.contains(h));
  const titleEl: Element | null = reference
    ? matching(h1s) ?? matching(headings("h2"))
    : inContent.length === 1
      ? inContent[0]
      : h1s.length === 1
        ? h1s[0]
        : null;
  // The heading as shown, unless it's the declared title with a label
  // around it ("Title: Attention Is All You Need").
  let shown = titleEl ? normalizeText(titleEl.textContent) : "";
  if (shown && declared && shown !== declared && shown.toLowerCase().includes(declared.toLowerCase())) shown = declared;
  const title =
    shown ||
    reference ||
    ld.headline ||
    (documentTitle ? cleanDocumentTitle(documentTitle, siteName) : "") ||
    host ||
    "Web page";

  const header = titleEl ? headerOf(titleEl) : null;

  // ---- Authors: named people, from the most to the least deliberate source.
  let authors = metaContents(doc, "citation_author");
  if (authors.length === 0) authors = ld.authors.filter((a) => a.person).map((a) => a.name);
  if (authors.length === 0) {
    const named = metaContent(doc, "author", "article:author", "dc.creator", "parsely-author", "sailthru.author");
    if (named && !/^https?:/i.test(named)) authors = splitNames(named);
  }
  if (authors.length === 0 && header) authors = bylineIn(header, false);
  if (authors.length === 0) authors = bylineIn(root, true);
  if (authors.length === 0) authors = ld.authors.map((a) => a.name);
  // "Last, First" from citation tags reads better as "First Last".
  authors = [...new Set(authors.map((name) => (/^[^,]+,\s*[^,]+$/.test(name) ? name.split(/,\s*/).reverse().join(" ") : name)))];

  // ---- Dates
  let publishedAt = isoDate(
    metaContent(doc, "article:published_time", "og:published_time", "datePublished", "citation_publication_date", "citation_date", "dc.date.issued", "dc.date", "date", "parsely-pub-date", "sailthru.date") ??
      ld.datePublished,
  );
  let publishedLabel: string | undefined;
  if (!publishedAt) {
    const time = (header ?? root).querySelector("time[datetime]") ?? root.querySelector("time[datetime]");
    publishedAt = isoDate(time?.getAttribute("datetime") ?? undefined);
  }
  if (!publishedAt && header) {
    for (const { text } of shortTexts(header, 60)) {
      const date = parsePrintedDate(text);
      if (date) {
        publishedAt = date;
        publishedLabel = text.match(PRINTED_DATE)?.[0];
        break;
      }
    }
  }
  const modifiedAt = isoDate(metaContent(doc, "article:modified_time", "og:updated_time", "dateModified") ?? ld.dateModified);

  // ---- Subtitle: shown under the title, matching the page's description.
  const description = metaContent(doc, "og:description", "description", "twitter:description", "dc.description") ?? ld.description;
  let dek: string | undefined;
  if (header) {
    for (const el of header.querySelectorAll("p, h2, div, span")) {
      if (el === titleEl || el.contains(titleEl)) continue;
      const text = normalizeText(el.textContent);
      if (text.length < 20 || text.length > 400) continue;
      const deliberate = /(dek|sub-?title|subhead|standfirst|lede|summary|excerpt|tagline|description)/i.test(el.getAttribute("class") ?? "");
      if ((description && overlap(text, description) >= 0.8 && Math.abs(text.length - description.length) < 40) || deliberate) {
        dek = text;
        break;
      }
    }
  }

  const lang = doc.documentElement.getAttribute("lang") || metaContent(doc, "og:locale", "dc.language", "citation_language") || undefined;

  const canonicalHref = doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? metaContent(doc, "og:url");
  let canonicalUrl: string | undefined;
  if (canonicalHref) {
    try {
      const url = new URL(canonicalHref, finalUrl);
      if (url.protocol === "http:" || url.protocol === "https:") canonicalUrl = url.href;
    } catch {
      // Ignored: the final URL serves instead.
    }
  }

  let pdfUrl: string | undefined;
  const pdfHref = metaContent(doc, "citation_pdf_url");
  if (pdfHref) {
    try {
      pdfUrl = new URL(pdfHref, finalUrl).href;
    } catch {
      pdfUrl = undefined;
    }
  }

  return {
    title,
    authors,
    ...(siteName ? { siteName } : {}),
    ...(description ? { description } : {}),
    ...(dek ? { dek } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(publishedLabel ? { publishedLabel } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
    ...(lang ? { lang } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(pdfUrl ? { pdfUrl } : {}),
    ...(idOf(titleEl) ? { titleId: idOf(titleEl) } : {}),
    ...(idOf(header) ? { headerId: idOf(header) } : {}),
  };
}
