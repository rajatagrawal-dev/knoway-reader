import { pdfForEpub } from "../epub/index.ts";
import { pickTitle } from "../library/library.ts";
import { readPdfInfo } from "../library/pdfInfo.ts";
import { importDocument } from "../storage/documents.ts";
import type { DocumentMeta, DocumentSource, LibraryStorage } from "../storage/types.ts";
import { serverFetcher } from "./fetcher.ts";
import { classifyResource, decodeHtml } from "./html.ts";
import { readMetadata } from "./metadata.ts";
import type { PageRenderer } from "./renderer.ts";
import { WebImportError, type ImportProgress, type ImportReport, type PageMetadata, type WebFetcher } from "./types.ts";
import { arxivAbstractUrl, arxivId, canonicalizeUrl, fileNameFor, nameFromUrl, parseUserUrl, rewriteKnownUrl } from "./url.ts";

// "Add from URL": a web address to a document in the library.
//
//   address ─▶ fetch (fetcher.ts, through the app's server)
//     ├─ a PDF  ─▶ saved as it is (an arXiv paper titled from its abstract page)
//     ├─ an EPUB ─▶ converted like an EPUB file (epub/)
//     └─ a page ─▶ article found (metadata, prepare, extract, cleanup), its
//                   figures captured from a styled render (renderer.ts), its
//                   pictures saved (assets.ts), laid out as a book (book.ts)
//                   and converted to a PDF by the EPUB converter (convert.ts)
//
// The fetcher and the renderer are interfaces, so a headless browser could
// take over either (or both) without touching the rest.

export { looksLikeUrl, parseUserUrl } from "./url.ts";
export { WebImportError } from "./types.ts";
export type { ImportProgress, ImportReport } from "./types.ts";

export type AddFromUrlResult =
  | { status: "added"; meta: DocumentMeta; report: ImportReport | null }
  // Already in the library: by its address, or (`unchanged`) because the
  // page, fetched again, came out exactly the same.
  | { status: "existing"; meta: DocumentMeta; unchanged?: boolean };

export interface AddFromUrlOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
  force?: boolean; // fetch it again even if the address is already in the library
  // The page offers a PDF of the same work (a paper's landing page): take
  // the PDF instead? Without this, the page itself is saved.
  choosePdf?: (offer: { pdfUrl: string; title: string }) => Promise<boolean>;
  fetcher?: WebFetcher;
  renderer?: PageRenderer;
}

// Every form of an address that means the same document.
function sameDocumentKeys(...urls: (string | undefined)[]): Set<string> {
  const keys = new Set<string>();
  for (const url of urls) {
    if (!url) continue;
    try {
      keys.add(canonicalizeUrl(url));
      const id = arxivId(url);
      if (id) keys.add(canonicalizeUrl(arxivAbstractUrl(id.replace(/v\d+$/, ""))));
    } catch {
      // Not a URL: nothing to match.
    }
  }
  return keys;
}

// The library's document from any of these addresses, if there is one.
export async function findSaved(storage: LibraryStorage, ...urls: (string | undefined)[]): Promise<DocumentMeta | null> {
  const wanted = sameDocumentKeys(...urls);
  if (wanted.size === 0) return null;
  const documents = await storage.listDocuments();
  for (const doc of documents) {
    if (!doc.source || doc.fileMissing) continue;
    const keys = sameDocumentKeys(doc.source.canonicalUrl, doc.source.url, doc.source.finalUrl);
    if ([...keys].some((key) => wanted.has(key))) return doc;
  }
  return null;
}

function canonicalFor(...urls: (string | undefined)[]): string {
  for (const url of urls) {
    if (!url) continue;
    const id = arxivId(url);
    if (id) return canonicalizeUrl(arxivAbstractUrl(id.replace(/v\d+$/, "")));
  }
  return canonicalizeUrl(urls.find(Boolean)!);
}

function abortError() {
  return new DOMException("Cancelled", "AbortError");
}

export async function addFromUrl(storage: LibraryStorage, input: string, options: AddFromUrlOptions = {}): Promise<AddFromUrlResult> {
  const parsed = parseUserUrl(input);
  if (!parsed) throw new WebImportError("That doesn't look like a web address.");
  const requested = rewriteKnownUrl(parsed);
  const { signal } = options;
  const progress = options.onProgress ?? (() => {});
  const fetcher = options.fetcher ?? serverFetcher();

  progress({ stage: "checking" });
  if (!options.force) {
    const existing = await findSaved(storage, parsed.href, requested.href);
    if (existing) return { status: "existing", meta: existing };
  }

  progress({ stage: "fetching" });
  const resource = await fetcher.fetch(requested.href, { purpose: "page", signal });
  if (signal?.aborted) throw abortError();
  const fetchedAt = new Date().toISOString();
  const kind = classifyResource(resource.contentType, resource.bytes);
  const base = { url: parsed.href, finalUrl: resource.finalUrl, fetchedAt };

  if (kind === "pdf") return savePdf(storage, resource.bytes, { ...base, fetcher, signal, onProgress: progress });
  if (kind === "epub") return saveEpub(storage, resource.bytes, base, progress);

  let html: string;
  if (kind === "html") {
    html = decodeHtml(resource.bytes, resource.contentType);
  } else if (kind === "text") {
    // Plain text (a .txt, a raw Markdown file): kept exactly, as preformatted text.
    const text = decodeHtml(resource.bytes, resource.contentType);
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    html = `<!doctype html><html><head><title>${escape(nameFromUrl(resource.finalUrl))}</title></head><body><article><pre>${escape(text)}</pre></article></body></html>`;
  } else if (kind === "image") {
    throw new WebImportError("That address is a picture, not a page.");
  } else {
    throw new WebImportError(`Knoway can't read this kind of file (${resource.contentType.split(";")[0] || "unknown type"}).`);
  }

  const { readPage, convertArticle } = await import("./convert");
  const { frameRenderer } = await import("./renderer");
  progress({ stage: "reading" });
  const page = readPage(html, resource.finalUrl);

  // A paper's landing page offering its PDF.
  if (page.meta.pdfUrl && options.choosePdf && (await options.choosePdf({ pdfUrl: page.meta.pdfUrl, title: page.meta.title }))) {
    if (signal?.aborted) throw abortError();
    progress({ stage: "fetching" });
    const pdf = await fetcher.fetch(page.meta.pdfUrl, { purpose: "page", signal });
    if (classifyResource(pdf.contentType, pdf.bytes) !== "pdf") {
      throw new WebImportError("The page's PDF link didn't lead to a PDF. Try saving the page itself.");
    }
    return savePdf(storage, pdf.bytes, { ...base, finalUrl: pdf.finalUrl, pageUrl: resource.finalUrl, pageMeta: page.meta, fetcher, signal, onProgress: progress });
  }

  const canonicalUrl = canonicalFor(page.meta.canonicalUrl, resource.finalUrl);
  if (!options.force) {
    const existing = await findSaved(storage, canonicalUrl, resource.finalUrl);
    if (existing) return { status: "existing", meta: existing };
  }

  const converted = await convertArticle(page, {
    fetcher,
    renderer: options.renderer ?? frameRenderer(fetcher),
    sourceUrl: page.meta.canonicalUrl ?? resource.finalUrl,
    fetchedAt,
    signal,
    onProgress: progress,
  });
  if (signal?.aborted) throw abortError();

  progress({ stage: "saving" });
  const source: DocumentSource = {
    kind: "web",
    format: "article",
    ...base,
    canonicalUrl,
    ...(page.meta.siteName ? { siteName: page.meta.siteName } : {}),
    ...(page.meta.publishedAt ? { publishedAt: page.meta.publishedAt } : {}),
  };
  const saved = await saveToLibrary(storage, converted.pdf, {
    docId: converted.docId,
    title: page.meta.title,
    authors: page.meta.authors,
    source,
  });
  return saved.added ? { status: "added", meta: saved.meta, report: converted.report } : { status: "existing", meta: saved.meta, unchanged: true };
}

// ---- Into the library ---------------------------------------------------------------

async function saveToLibrary(
  storage: LibraryStorage,
  pdf: Uint8Array,
  details: { docId?: string; title: string; authors: string[]; source: DocumentSource },
): Promise<{ meta: DocumentMeta; added: boolean }> {
  const info = await readPdfInfo(pdf);
  if (!info) throw new WebImportError("The document couldn't be read after it was made.");
  const { meta, added } = await importDocument(storage, { bytes: pdf, fileName: fileNameFor(details.title), docId: details.docId });
  if (!added) {
    // The same document was already here (perhaps added as a file): it now
    // knows where it came from too.
    if (!meta.source) {
      const updated = { ...meta, source: details.source };
      await storage.putMeta(updated);
      return { meta: updated, added: false };
    }
    return { meta, added: false };
  }
  const complete: DocumentMeta = {
    ...meta,
    title: details.title,
    pageCount: info.pageCount,
    ...(details.authors.length ? { author: details.authors.join(", ") } : info.author ? { author: info.author } : {}),
    source: details.source,
  };
  await storage.putMeta(complete);
  if (info.thumbnail) await storage.putData(meta.docId, "thumbnail", info.thumbnail);
  return { meta: complete, added: true };
}

// A PDF the address led to. Its title and authors come from the page that
// offered it, or for an arXiv paper from its abstract page (arXiv's PDFs
// carry no title of their own), or else from the PDF itself.
async function savePdf(
  storage: LibraryStorage,
  bytes: Uint8Array,
  options: {
    url: string;
    finalUrl: string;
    fetchedAt: string;
    pageUrl?: string;
    pageMeta?: PageMetadata;
    fetcher: WebFetcher;
    signal?: AbortSignal;
    onProgress: (progress: ImportProgress) => void;
  },
): Promise<AddFromUrlResult> {
  let pageMeta = options.pageMeta;
  const id = arxivId(options.finalUrl) ?? arxivId(options.url);
  if (!pageMeta && id) {
    options.onProgress({ stage: "reading" });
    try {
      const abstract = await options.fetcher.fetch(arxivAbstractUrl(id), { purpose: "page", signal: options.signal });
      const doc = new DOMParser().parseFromString(decodeHtml(abstract.bytes, abstract.contentType), "text/html");
      pageMeta = readMetadata(doc, abstract.finalUrl);
    } catch {
      pageMeta = undefined; // the PDF's own details will do
    }
  }
  options.onProgress({ stage: "saving" });
  const info = await readPdfInfo(bytes);
  if (!info) throw new WebImportError("The address led to a PDF that couldn't be read.");
  const title = pageMeta?.title || pickTitle(info.title, nameFromUrl(options.finalUrl));
  const source: DocumentSource = {
    kind: "web",
    format: "pdf",
    url: options.url,
    finalUrl: options.finalUrl,
    canonicalUrl: canonicalFor(options.finalUrl, options.url),
    fetchedAt: options.fetchedAt,
    ...(pageMeta?.siteName ? { siteName: pageMeta.siteName } : {}),
    ...(pageMeta?.publishedAt ? { publishedAt: pageMeta.publishedAt } : {}),
  };
  const saved = await saveToLibrary(storage, bytes, { title, authors: pageMeta?.authors ?? [], source });
  return saved.added ? { status: "added", meta: saved.meta, report: null } : { status: "existing", meta: saved.meta, unchanged: true };
}

async function saveEpub(
  storage: LibraryStorage,
  bytes: Uint8Array,
  base: { url: string; finalUrl: string; fetchedAt: string },
  onProgress: (progress: ImportProgress) => void,
): Promise<AddFromUrlResult> {
  onProgress({ stage: "layout" });
  const epub = await pdfForEpub(storage, bytes);
  if (epub.existing) return { status: "existing", meta: epub.existing, unchanged: true };
  onProgress({ stage: "saving" });
  const info = await readPdfInfo(epub.pdf);
  if (!info) throw new WebImportError("The EPUB couldn't be converted.");
  const source: DocumentSource = { kind: "web", format: "epub", ...base, canonicalUrl: canonicalFor(base.finalUrl, base.url) };
  const { meta, added } = await importDocument(storage, { bytes: epub.pdf, fileName: fileNameFor(nameFromUrl(base.finalUrl), "epub"), docId: epub.docId });
  if (!added) return { status: "existing", meta, unchanged: true };
  const complete: DocumentMeta = {
    ...meta,
    title: pickTitle(info.title, meta.title),
    pageCount: info.pageCount,
    ...(info.author ? { author: info.author } : {}),
    source,
  };
  await storage.putMeta(complete);
  if (info.thumbnail) await storage.putData(meta.docId, "thumbnail", info.thumbnail);
  return { status: "added", meta: complete, report: null };
}
