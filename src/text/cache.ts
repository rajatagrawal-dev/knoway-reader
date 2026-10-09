import type { PdfExtractedPage, PdfTextItem } from "react-pdf-highlighter-plus";

// Extracting every page's text takes seconds on a long book, so the result
// is stored with the document (the "textIndex" kind) and reused on reopen.
// Stored compactly — a text item is a tuple, rects rounded to 1/100 pt — as
// a 500-page book has well over a hundred thousand items.

// Bump when the stored shape or the extraction it caches changes; older
// caches are then ignored and rebuilt.
export const TEXT_CACHE_VERSION = 1;

// [text, left, top, width, height, index]
type CompactItem = [string, number, number, number, number, number];

interface CompactPage {
  n: number; // pageNumber
  w: number;
  h: number;
  items: CompactItem[];
}

export interface CachedText {
  version: number;
  // Which PDF this was extracted from, checked on load: a cache that doesn't
  // match (a different file under the same id would be a bug, but a cheap
  // one to guard against) is ignored rather than trusted.
  fingerprint: string;
  numPages: number;
  pages: CompactPage[];
}

export interface CacheIdentity {
  fingerprint: string;
  numPages: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function compactPages(pages: PdfExtractedPage[], identity: CacheIdentity): CachedText {
  return {
    version: TEXT_CACHE_VERSION,
    fingerprint: identity.fingerprint,
    numPages: identity.numPages,
    pages: pages.map((page) => ({
      n: page.pageNumber,
      w: page.width,
      h: page.height,
      items: page.textItems.map((item): CompactItem => [
        item.text,
        round(item.rect.left),
        round(item.rect.top),
        round(item.rect.width),
        round(item.rect.height),
        item.index,
      ]),
    })),
  };
}

// The cached pages, or null if the cache is missing, from another version,
// or from another PDF.
export function expandPages(cached: unknown, identity: CacheIdentity): PdfExtractedPage[] | null {
  if (!cached || typeof cached !== "object") return null;
  const cache = cached as CachedText;
  if (
    cache.version !== TEXT_CACHE_VERSION ||
    cache.fingerprint !== identity.fingerprint ||
    cache.numPages !== identity.numPages ||
    !Array.isArray(cache.pages)
  ) {
    return null;
  }
  return cache.pages.map((page) => ({
    pageNumber: page.n,
    width: page.w,
    height: page.h,
    textItems: page.items.map(
      ([text, left, top, width, height, index]): PdfTextItem => ({
        text,
        index,
        pageNumber: page.n,
        rect: { left, top, width, height, pageNumber: page.n },
      }),
    ),
  }));
}
