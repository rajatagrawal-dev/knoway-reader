import { convertBookToPdf } from "../epub/convert.ts";
import { BOOK_PAGE, columnSize } from "../epub/writePdf.ts";
import { computeDocId } from "../storage/documents.ts";
import { saveImages } from "./assets.ts";
import { buildArticleBook } from "./book.ts";
import { cleanArticle, isIconSvg } from "./cleanup.ts";
import { extractArticle } from "./extract.ts";
import { normalizeText } from "./html.ts";
import { readMetadata } from "./metadata.ts";
import { ID_ATTR, preparePage, tagElements, type Island } from "./prepare.ts";
import type { PageRenderer, RenderedPage, Snapshot } from "./renderer.ts";
import { emptyReport, WebImportError, type ImportProgress, type ImportReport, type PageMetadata, type WebFetcher } from "./types.ts";

// A web page (HTML) to a PDF of its article. Loaded only when a page is
// being added (see index.ts for the whole flow, PDFs and EPUBs included).

export interface ReadPage {
  doc: Document;
  taggedHtml: string; // as fetched, with data-kr-id on every element (for the styled render)
  finalUrl: string;
  meta: PageMetadata;
}

export interface ConvertedArticle {
  pdf: Uint8Array;
  docId: string;
  meta: PageMetadata;
  report: ImportReport;
}

export function readPage(html: string, finalUrl: string): ReadPage {
  const doc = new DOMParser().parseFromString(html, "text/html");
  tagElements(doc);
  const taggedHtml = `<!doctype html>${doc.documentElement.outerHTML}`;
  return { doc, taggedHtml, finalUrl, meta: readMetadata(doc, finalUrl) };
}

// Signs that the page is put together by scripts, which aren't run here.
function needsScripts(html: string): boolean {
  return (
    /<noscript[^>]*>[\s\S]{0,400}?(enable|requires?|turn on)[\s\S]{0,40}?javascript/i.test(html) ||
    /<(div|main|body)[^>]+id=["'](root|app|__next|__nuxt|svelte|ember-app)["'][^>]*>\s*<\/\1>/i.test(html)
  );
}

// ---- Figures and pictures from the styled render -------------------------------------

// The figure as captured, with its words laid invisibly over it — so they
// can still be searched, selected and asked about.
function placeSnapshot(placeholder: Element, island: Island, snapshot: Snapshot, path: string) {
  const doc = placeholder.ownerDocument;
  const img = placeholder.querySelector('img[src^="kr-island:"]');
  const wrap = doc.createElement("div");
  wrap.setAttribute("class", "kr-snapshot");
  wrap.setAttribute("style", `width:${Math.round(snapshot.width)}px;max-width:100%`);
  const picture = doc.createElement("img");
  picture.setAttribute("src", path);
  picture.setAttribute("alt", island.alt);
  picture.setAttribute("width", String(Math.round(snapshot.width)));
  picture.setAttribute("height", String(Math.round(snapshot.height)));
  wrap.append(picture);
  const words = [...new Set([island.alt, island.text].filter(Boolean))].join(" — ");
  if (words) {
    const column = columnSize(BOOK_PAGE).width;
    const width = Math.min(snapshot.width, column);
    const height = snapshot.height * (width / snapshot.width);
    // Small enough that all of it fits over the picture.
    const size = Math.max(1, Math.min(10, Math.sqrt((width * height * 0.8) / (words.length * 0.55 * 1.15))));
    const overlay = doc.createElement("div");
    overlay.setAttribute("class", "kr-snapshot-text");
    overlay.setAttribute("data-kr-invisible", "");
    overlay.setAttribute("style", `font-size:${size.toFixed(2)}px`);
    overlay.textContent = words;
    wrap.append(overlay);
  }
  if (img) img.replaceWith(wrap);
  else placeholder.prepend(wrap);
}

// A figure that couldn't be captured keeps its words, as plain text.
function placeFallback(placeholder: Element, island: Island, pageUrl: string) {
  const doc = placeholder.ownerDocument;
  const img = placeholder.querySelector('img[src^="kr-island:"]');
  const holder = doc.createElement("div");
  if (island.kind === "css") {
    const copy = doc.importNode(island.element, true) as Element;
    copy.querySelector(":scope > figcaption")?.remove();
    holder.append(copy);
    cleanArticle(holder, "");
  }
  if (!normalizeText(holder.textContent)) {
    const note = doc.createElement("span");
    note.setAttribute("data-kr-missing", "");
    note.append(`${island.kind === "canvas" ? "An interactive figure, drawn by the page's scripts" : "A figure that couldn't be captured"}${island.alt ? ` (${island.alt})` : ""} — `);
    const link = doc.createElement("a");
    link.setAttribute("href", pageUrl);
    link.textContent = "view it on the web";
    note.append(link);
    holder.replaceChildren(note);
  }
  if (img) img.replaceWith(...holder.childNodes);
  else placeholder.prepend(...holder.childNodes);
}

async function captureFromRender(
  content: HTMLElement,
  islands: Map<string, Island>,
  render: RenderedPage | null,
  files: Map<string, Uint8Array>,
  report: ImportReport,
  pageUrl: string,
  onProgress: (done: number, total: number) => void,
) {
  const doc = content.ownerDocument;
  const placeholders = [...content.querySelectorAll("[data-kr-island]")];
  const svgs = [...content.querySelectorAll("svg")].filter((svg) => !svg.parentElement?.closest("svg"));
  const total = placeholders.length + svgs.length;
  let done = 0;

  // Inline SVG: its true size and colours come from the site's CSS.
  for (const svg of svgs) {
    const id = svg.getAttribute(ID_ATTR);
    const size = render && id ? await render.size(id) : null;
    if (size && size.width <= 32 && size.height <= 32) {
      svg.remove(); // an icon after all
    } else if (render && id && size && size.width > 0) {
      const standalone = await render.standaloneSvg(id);
      if (standalone) {
        const parsed = new DOMParser().parseFromString(standalone.svg, "image/svg+xml").documentElement;
        if (parsed.localName === "svg") svg.replaceWith(doc.importNode(parsed, true));
      }
    } else if (render && id && size && size.width === 0) {
      svg.remove(); // not shown on the page
    } else if (isIconSvg(svg)) {
      svg.remove();
    }
    onProgress(++done, total);
  }

  let counter = 0;
  for (const placeholder of placeholders) {
    const id = placeholder.getAttribute("data-kr-island")!;
    const island = islands.get(id);
    if (!island) {
      placeholder.remove();
      continue;
    }
    const snapshot = render ? await render.snapshot(id) : null;
    if (snapshot) {
      const path = `images/figure-${String(++counter).padStart(2, "0")}.png`;
      files.set(path, snapshot.png);
      placeSnapshot(placeholder, island, snapshot, path);
      report.figuresCaptured += 1;
    } else {
      placeFallback(placeholder, island, pageUrl);
      report.figuresFailed += 1;
    }
    placeholder.removeAttribute("data-kr-island");
    onProgress(++done, total);
  }
}

// ---- The conversion -----------------------------------------------------------------

// The document's identity: what it says and shows — not the day it was
// saved, so the same page saved again comes out as the same document.
async function contentHash(chapter: string, files: Map<string, Uint8Array>): Promise<string> {
  const undated = chapter.replace(/<p class="kr-meta">[\s\S]*?<\/p>/, "");
  const parts = [new TextEncoder().encode(undated), ...[...files.keys()].sort().map((path) => files.get(path)!)];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.byteLength;
  }
  return computeDocId(all);
}

export async function convertArticle(
  page: ReadPage,
  options: {
    fetcher: WebFetcher;
    renderer?: PageRenderer;
    sourceUrl: string;
    fetchedAt: string;
    signal?: AbortSignal;
    onProgress?: (progress: ImportProgress) => void;
  },
): Promise<ConvertedArticle> {
  const { meta, finalUrl } = page;
  const report = emptyReport();
  const progress = options.onProgress ?? (() => {});
  const aborted = () => {
    if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  };

  progress({ stage: "reading" });
  const prepared = preparePage(page.doc, finalUrl, meta.canonicalUrl);
  const { content, restoredBlocks, usedFallback } = extractArticle(prepared, meta);
  report.restoredBlocks = restoredBlocks;
  cleanArticle(content, meta.title);

  const textLength = normalizeText(content.textContent).length;
  const pictures = content.querySelectorAll("img, svg, [data-kr-island]").length;
  const scripted = needsScripts(page.taggedHtml);
  if (textLength < 200 && pictures === 0) {
    throw new WebImportError(
      scripted
        ? "This page builds its content with JavaScript, which Knoway can't run yet, so there was nothing to save."
        : "Couldn't find any readable content on this page.",
    );
  }
  if (scripted && textLength < 1500) {
    report.warnings.push("This page builds some of its content with JavaScript, which Knoway can't run yet. Parts of it may be missing.");
  }
  if (usedFallback) {
    report.warnings.push("Knoway couldn't tell the article apart from the rest of the page, so it kept the page's whole main section.");
  }
  aborted();

  const files = new Map<string, Uint8Array>();
  const needsRender = content.querySelector("[data-kr-island], svg") !== null;
  let render: RenderedPage | null = null;
  try {
    if (needsRender && options.renderer) {
      progress({ stage: "figures" });
      try {
        render = await options.renderer.open({ html: page.taggedHtml, url: finalUrl }, { signal: options.signal });
      } catch (error) {
        console.warn("Styled render failed:", error);
        report.warnings.push("The page couldn't be rendered with its own styling, so figures drawn with it are kept as text.");
      }
    }
    if (needsRender) {
      await captureFromRender(content, prepared.islands, render, files, report, finalUrl, (done, total) =>
        progress({ stage: "figures", done, total }),
      );
    }
  } finally {
    render?.close();
  }
  aborted();

  progress({ stage: "images", done: 0, total: 0 });
  await saveImages(content, {
    fetcher: options.fetcher,
    pageUrl: finalUrl,
    files,
    report,
    signal: options.signal,
    onProgress: (done, total) => progress({ stage: "images", done, total }),
  });
  aborted();

  for (const card of content.querySelectorAll("[data-kr-media]")) {
    const title = card.getAttribute("data-kr-media-title");
    report.media.push({
      kind: card.getAttribute("data-kr-media") as ImportReport["media"][number]["kind"],
      url: card.getAttribute("data-kr-media-url") ?? finalUrl,
      ...(title ? { title } : {}),
    });
    card.removeAttribute("data-kr-media-url");
    card.removeAttribute("data-kr-media-title");
  }
  report.mathAsTex = content.querySelectorAll("[data-kr-math]").length;

  progress({ stage: "layout" });
  const { book, chapter } = buildArticleBook({ meta, sourceUrl: options.sourceUrl, fetchedAt: options.fetchedAt, content, files });
  const docId = await contentHash(chapter, files);
  const { pdf } = await convertBookToPdf(book, { producer: "Knoway Reader (from a web page)" });
  return { pdf, docId, meta, report };
}
