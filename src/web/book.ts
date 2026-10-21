import type { EpubBook } from "../epub/book.ts";
import type { PageMetadata } from "./types.ts";

// A web article as a one-chapter book, for the EPUB converter
// (epub/convert.ts's convertBookToPdf) to lay out and turn into a PDF: the
// article under a header saying what it is and where it came from, in a
// stylesheet that sets it like the rest of the library's EPUBs.

export const CHAPTER_PATH = "article.xhtml";
const STYLESHEET_PATH = "article.css";

// Book typography; fonts and justification are fixed by the layout itself.
export const ARTICLE_CSS = `
html { font-size: 16px; }
body { line-height: 1.5; color: #1b1b1b; }
.kr-source { margin: 0 0 1.6em; padding-bottom: 1em; border-bottom: 1px solid #d6d6d6; }
.kr-site { margin: 0 0 0.5em; font-size: 0.78em; color: #6b6b6b; text-transform: uppercase; }
.kr-title { margin: 0 0 0.4em; font-size: 1.75em; line-height: 1.2; font-weight: 700; }
.kr-dek { margin: 0 0 0.7em; font-size: 1.05em; font-style: italic; color: #444; }
.kr-byline { margin: 0 0 0.25em; font-size: 0.92em; }
.kr-meta { margin: 0 0 0.25em; font-size: 0.8em; color: #6b6b6b; }
.kr-url { margin: 0; font-size: 0.78em; color: #6b6b6b; overflow-wrap: anywhere; }
.kr-url a { color: #6b6b6b; }
h1 { font-size: 1.5em; line-height: 1.25; margin: 1.3em 0 0.5em; }
h2 { font-size: 1.32em; line-height: 1.25; margin: 1.4em 0 0.5em; }
h3 { font-size: 1.14em; line-height: 1.3; margin: 1.25em 0 0.4em; }
h4, h5, h6 { font-size: 1em; margin: 1.1em 0 0.35em; }
p { margin: 0 0 0.85em; }
a { color: #1f4e99; text-decoration: none; }
img { max-width: 100%; height: auto; }
figure { margin: 1.2em 0; }
figure > img, figure > a > img, .kr-article > img, p > img:only-child { display: block; margin: 0 auto; }
figcaption { margin-top: 0.45em; font-size: 0.85em; line-height: 1.4; color: #555; }
blockquote { margin: 1em 0; padding: 0.1em 0 0.1em 1em; border-left: 3px solid #cfcfcf; color: #333; }
pre { margin: 1em 0; padding: 0.7em 0.8em; background: #f4f4f1; font-size: 0.8em; line-height: 1.45;
  white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
code, kbd, samp { font-family: monospace; font-size: 0.88em; }
pre code { font-size: inherit; }
:not(pre) > code { background: #f0f0ed; padding: 0 0.2em; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.82em; line-height: 1.4; }
th, td { border: 1px solid #cdcdcd; padding: 0.3em 0.45em; vertical-align: top; text-align: left; overflow-wrap: anywhere; }
th { background: #f1f1ee; font-weight: 700; }
caption { margin-bottom: 0.4em; font-size: 0.95em; color: #555; }
ul, ol { margin: 0 0 0.85em; padding-left: 1.5em; }
li { margin: 0.2em 0; }
li > p { margin: 0 0 0.4em; }
dt { font-weight: 700; }
dd { margin: 0 0 0.5em 1.5em; }
hr { border: 0; border-top: 1px solid #cfcfcf; margin: 1.5em 0; }
sup, sub { font-size: 0.75em; line-height: 0; }
details > summary { display: block; font-weight: 700; margin-bottom: 0.4em; }
aside, [data-kr-callout] { display: block; margin: 1.1em 0; padding: 0.6em 0.85em; border-left: 3px solid #c9c9c4; background: #f6f6f3; font-size: 0.93em; }
aside > :last-child, [data-kr-callout] > :last-child { margin-bottom: 0; }
[data-kr-math] { font-family: monospace; font-size: 0.88em; }
[data-kr-math="display"] { display: block; margin: 0.9em 0; text-align: center; overflow-wrap: anywhere; }
[data-kr-media] { padding: 0.6em 0.8em; border: 1px solid #d8d8d8; background: #f7f7f4; }
[data-kr-media] figcaption { margin: 0; color: #333; overflow-wrap: anywhere; }
[data-kr-media] img { margin-bottom: 0.5em; }
[data-kr-missing] { display: block; margin: 0.8em 0; padding: 0.4em 0.6em; border: 1px solid #cfcfcf; font-size: 0.85em; color: #666; }
.kr-snapshot { position: relative; margin: 0 auto; }
.kr-snapshot > img { display: block; width: 100%; height: auto; }
.kr-snapshot-text { position: absolute; left: 0; top: 0; right: 0; bottom: 0; overflow: hidden; line-height: 1.15; color: #000; }
`;

function formatDate(iso: string | undefined, label: string | undefined): string | null {
  if (label) return label;
  if (!iso) return null;
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

// oxlint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

export interface ArticleBookInput {
  meta: PageMetadata;
  sourceUrl: string; // shown under the title, and linked
  fetchedAt: string;
  content: HTMLElement;
  files: Map<string, Uint8Array>; // the pictures, by the paths the article uses
}

export function buildArticleBook(input: ArticleBookInput): { book: EpubBook; chapter: string } {
  const { meta, content } = input;
  const doc = document.implementation.createDocument("http://www.w3.org/1999/xhtml", "html", null);
  const html = doc.documentElement;
  if (meta.lang) {
    html.setAttribute("lang", meta.lang);
    html.setAttribute("xml:lang", meta.lang);
  }
  const make = (tag: string, attrs: Record<string, string> = {}, text?: string) => {
    const el = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const head = make("head");
  head.append(make("meta", { charset: "utf-8" }), make("title", {}, meta.title), make("link", { rel: "stylesheet", href: STYLESHEET_PATH }));
  const body = make("body");
  html.append(head, body);

  const header = make("header", { class: "kr-source" });
  if (meta.siteName) header.append(make("p", { class: "kr-site" }, meta.siteName));
  header.append(make("h1", { class: "kr-title" }, meta.title));
  if (meta.dek) header.append(make("p", { class: "kr-dek" }, meta.dek));
  if (meta.authors.length) header.append(make("p", { class: "kr-byline" }, `By ${meta.authors.join(", ")}`));
  const published = formatDate(meta.publishedAt, meta.publishedLabel);
  const saved = formatDate(input.fetchedAt, undefined);
  header.append(make("p", { class: "kr-meta" }, [published ? `Published ${published}` : null, `Saved ${saved}`].filter(Boolean).join(" · ")));
  const urlLine = make("p", { class: "kr-url" });
  urlLine.append(make("a", { href: input.sourceUrl }, input.sourceUrl));
  header.append(urlLine);
  body.append(header);

  const article = make("article", { class: "kr-article" });
  // Moved over from the HTML document; serialized below as XHTML, so it
  // reaches the layout exactly as built (an HTML parser would re-nest it).
  for (const node of [...content.childNodes]) article.append(doc.importNode(node, true));
  for (const el of article.querySelectorAll("[data-kr-id]")) el.removeAttribute("data-kr-id");
  body.append(article);

  const walker = doc.createTreeWalker(body, 4); // NodeFilter.SHOW_TEXT
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    const clean = value.replace(XML_INVALID, "");
    if (clean !== value) node.nodeValue = clean;
  }

  const chapter = `<?xml version="1.0" encoding="utf-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
  const files = new Map<string, Uint8Array>(input.files);
  files.set(CHAPTER_PATH, new TextEncoder().encode(chapter));
  files.set(STYLESHEET_PATH, new TextEncoder().encode(ARTICLE_CSS));
  return {
    book: {
      files,
      title: meta.title,
      authors: meta.authors,
      ...(meta.lang ? { language: meta.lang } : {}),
      spine: [CHAPTER_PATH],
      toc: [], // the PDF's outline comes from the headings
    },
    chapter,
  };
}
