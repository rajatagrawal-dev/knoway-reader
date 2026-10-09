import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { DocumentTextIndex } from "../glossary/textIndex";
import { regionTextRange } from "../grounding/attachments";
import { trimPartialWords, type XrefKind, type XrefRef, type XrefTarget, type XrefTargets } from "./detect";

// References from the PDF's own link annotations — what LaTeX's hyperref
// (and most typesetting tools) put on every "Eq. (3.2)", "[12]" and
// "Section 4". Their destinations are exact, so they beat anything guessed
// from the text: where a link and a text pattern cover the same words, the
// link wins (see xrefIndex.ts).

interface LinkAnnotation {
  id: string;
  subtype: string;
  rect: number[];
  dest?: string | unknown[] | null;
  url?: string;
}

// How far down a preview reaches below a link's destination, by what it is.
const PREVIEW_HEIGHT: Record<XrefKind, number> = {
  equation: 0.08,
  theorem: 0.22,
  figure: 0.45,
  table: 0.35,
  section: 0.2,
  citation: 0.07,
  link: 0.2,
};

// What a link's own words say it points at.
function kindFromText(text: string): XrefKind {
  const t = text.trim();
  if (/^\[?\d+(?:\s*[,–-]\s*\d+)*\]?$/.test(t)) return "citation";
  if (/^\(?\d+(?:\.\d+)*[a-z]?\)?$/.test(t) || /^eq/i.test(t)) return "equation";
  if (/^(?:fig|figure)/i.test(t)) return "figure";
  if (/^(?:tab|table)/i.test(t)) return "table";
  if (/^(?:sec|section|§|chapter|ch\.|appendix)/i.test(t)) return "section";
  if (/^(?:theorem|thm|lemma|prop|corollary|cor\.|definition|def\.|example|exercise|remark|claim|conjecture|problem|algorithm)/i.test(t)) {
    return "theorem";
  }
  return "link";
}

export interface LinkRefs {
  refs: XrefRef[]; // links over text, placed on it
  byAnnotation: Map<string, XrefTarget>; // every internal link, text or not, for its click
}

export async function readLinkRefs(pdf: PDFDocumentProxy, index: DocumentTextIndex, targets: XrefTargets): Promise<LinkRefs> {
  const pages = new Map<number, Promise<PDFPageProxy>>();
  const getPage = (n: number) => {
    let page = pages.get(n);
    if (!page) {
      page = pdf.getPage(n);
      pages.set(n, page);
    }
    return page;
  };
  const known = [...targets.byKey.values()];
  const refs: XrefRef[] = [];
  const byAnnotation = new Map<string, XrefTarget>();

  // Where a destination points: its page, and how far down it (0–1).
  const resolve = async (dest: LinkAnnotation["dest"]): Promise<{ pageNumber: number; top: number } | null> => {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest).catch(() => null) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const pageRef = explicit[0];
    const pageIndex =
      typeof pageRef === "number" ? pageRef : await pdf.getPageIndex(pageRef as never).catch(() => -1);
    if (pageIndex < 0 || pageIndex >= pdf.numPages) return null;
    const mode = (explicit[1] as { name?: string } | undefined)?.name;
    const y = mode === "XYZ" ? explicit[3] : mode === "FitH" || mode === "FitBH" ? explicit[2] : null;
    if (typeof y !== "number") return { pageNumber: pageIndex + 1, top: 0 };
    const viewport = (await getPage(pageIndex + 1)).getViewport({ scale: 1 });
    const [, vy] = viewport.convertToViewportPoint(0, y);
    return { pageNumber: pageIndex + 1, top: Math.min(1, Math.max(0, vy / viewport.height)) };
  };

  for (let n = 1; n <= pdf.numPages; n += 1) {
    const page = await getPage(n);
    const annotations = (await page.getAnnotations().catch(() => [])) as LinkAnnotation[];
    const links = annotations.filter((a) => a.subtype === "Link" && a.dest && !a.url);
    if (links.length === 0) continue;
    const viewport = page.getViewport({ scale: 1 });
    const indexed = index.pages[n - 1];
    for (const link of links) {
      const where = await resolve(link.dest);
      if (!where) continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(link.rect);
      const found = indexed
        ? regionTextRange(indexed, {
            x1: Math.min(x1, x2),
            y1: Math.min(y1, y2),
            x2: Math.max(x1, x2),
            y2: Math.max(y1, y2),
            width: viewport.width,
            height: viewport.height,
          })
        : null;
      const range = found && indexed ? trimPartialWords(indexed.text, found) : null;
      const text = range && indexed ? indexed.text.slice(range[0], range[1]) : "";

      // A target the text patterns already found right there (its crop and
      // name are better informed); else one built from the link's words.
      const near = (t: XrefTarget) => t.pageNumber === where.pageNumber && Math.abs(t.top - where.top) < 0.06;
      const entry = targets.bibliography.find(
        (e) => e.pageNumber === where.pageNumber && Math.abs(e.top - where.top) < 0.05,
      );
      const kind = kindFromText(text);
      const target: XrefTarget =
        (kind === "citation" && entry
          ? {
              kind: "citation",
              key: `citation:${entry.key ?? text}`,
              name: text.trim() || `p. ${where.pageNumber}`,
              pageNumber: entry.pageNumber,
              top: entry.top,
              bottom: Math.min(1, entry.top + PREVIEW_HEIGHT.citation),
              range: [entry.start, entry.start + Math.min(entry.text.length, 40)],
              entryText: entry.text,
            }
          : known.find(near)) ?? {
          kind,
          key: `link:${where.pageNumber}:${where.top.toFixed(3)}`,
          name: text.trim() || `p. ${where.pageNumber}`,
          pageNumber: where.pageNumber,
          top: Math.max(0, where.top - 0.01),
          bottom: Math.min(1, where.top + PREVIEW_HEIGHT[kind]),
        };
      byAnnotation.set(link.id, target);
      if (range && text.trim()) {
        refs.push({
          id: `p${n}-${range[0]}`,
          pageNumber: n,
          start: range[0],
          end: range[1],
          text,
          targets: [target],
          annotationId: link.id,
        });
      }
    }
  }
  return { refs, byAnnotation };
}
