import fontkit from "@pdf-lib/fontkit";
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  setTextRenderingMode,
  TextRenderingMode,
  type PDFFont,
  type PDFImage,
  type PDFPage,
  type PDFRef,
} from "pdf-lib";
import type { TocEntry } from "./book.ts";
import { pageAt, paginate } from "./paginate.ts";
import type { FontName, ImageBox, ImageSource, LaidOutChapter, TextRun } from "./types.ts";

// Draws the laid-out chapters into a PDF: real text (selectable, searchable,
// in reading order), the book's pictures, its rules and shading, its links
// and its table of contents as the PDF's outline. The reader then treats it
// like any other PDF.

export interface PageGeometry {
  width: number; // points
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  scale: number; // points per CSS pixel of the layout
}

// A 6×9in trade paperback, with the book's 16px body text set at 11pt.
export const BOOK_PAGE: PageGeometry = {
  width: 432,
  height: 648,
  margin: { top: 54, right: 50, bottom: 54, left: 50 },
  scale: 11 / 16,
};

// The text column, in CSS pixels: the width the book is laid out at, and
// the height of one page of it.
export function columnSize(page: PageGeometry): { width: number; height: number } {
  return {
    width: (page.width - page.margin.left - page.margin.right) / page.scale,
    height: (page.height - page.margin.top - page.margin.bottom) / page.scale,
  };
}

export interface LoadedImage {
  bytes: Uint8Array;
  type: "jpeg" | "png";
}

export interface WritePdfInput {
  title?: string;
  authors: string[];
  language?: string;
  toc: TocEntry[];
  chapters: LaidOutChapter[];
  fonts: Record<FontName, Uint8Array>;
  // The picture's bytes, as JPEG or PNG (converting from GIF, WebP, SVG, …
  // as needed), for drawing at the given size in points; `redraw` asks for
  // it redrawn as a PNG whatever it was.
  loadImage(source: ImageSource, width: number, height: number, redraw: boolean): Promise<LoadedImage | null>;
  page?: PageGeometry;
  producer?: string; // what the PDF was made from, for its metadata
}

// Ligatures and kerning off, as in the layout (layout.ts): glyphs advance
// exactly as the browser measured them.
const PLAIN_FEATURES = { liga: false, clig: false, calt: false, dlig: false, kern: false };

// Characters that take no room and draw nothing: soft hyphens, zero-width
// spaces and joiners, byte-order marks, controls.
// oxlint-disable-next-line no-control-regex
const INVISIBLE = /[\u00ad\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff\u0000-\u001f\u007f]/g;

interface Destination {
  pageIndex: number;
  y: number; // points from the page's bottom
}

export async function writePdf(input: WritePdfInput): Promise<Uint8Array> {
  const geometry = input.page ?? BOOK_PAGE;
  const column = columnSize(geometry);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  if (input.title) pdf.setTitle(input.title);
  if (input.authors.length > 0) pdf.setAuthor(input.authors.join(", "));
  if (input.language) pdf.setLanguage(input.language);
  pdf.setCreator("Knowbel Reader");
  pdf.setProducer(input.producer ?? "Knowbel Reader (from EPUB)");

  // ---- Fonts: embedded (subset) on first use ----
  const embedded = new Map<FontName, { font: PDFFont; glyphs: Set<number> }>();
  const fontFor = async (name: FontName) => {
    let entry = embedded.get(name);
    if (!entry) {
      const font = await pdf.embedFont(input.fonts[name], { subset: true, features: PLAIN_FEATURES });
      entry = { font, glyphs: new Set(font.getCharacterSet()) };
      embedded.set(name, entry);
    }
    return entry;
  };

  // ---- Images: each file embedded once, however often it's drawn ----
  const images = new Map<string, Promise<PDFImage | null>>();
  const imageFor = (source: ImageSource, width: number, height: number) => {
    const key = "path" in source ? `path:${source.path}` : `svg:${width}x${height}:${source.svg}`;
    let image = images.get(key);
    if (!image) {
      const embed = async (redraw: boolean) => {
        const loaded = await input.loadImage(source, width, height, redraw).catch(() => null);
        if (!loaded) return null;
        return loaded.type === "jpeg" ? pdf.embedJpg(loaded.bytes) : pdf.embedPng(loaded.bytes);
      };
      // A JPEG or PNG pdf-lib can't parse is redrawn as a plain PNG.
      image = embed(false).catch(() => embed(true).catch(() => null));
      images.set(key, image);
    }
    return image;
  };

  const pages: PDFPage[] = [];
  const anchors = new Map<string, Destination>();
  const pendingLinks: { pageIndex: number; rect: number[]; target: string; external: boolean }[] = [];
  const headings: { level: number; title: string; dest: Destination }[] = [];

  const toY = (pageTop: number, y: number) => geometry.height - geometry.margin.top - (y - pageTop) * geometry.scale;
  const toX = (x: number) => geometry.margin.left + x * geometry.scale;

  const drawRun = async (page: PDFPage, run: TextRun, pageTop: number) => {
    const text = run.text.replace(INVISIBLE, "").replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000\t]/g, " ");
    if (!text.trim()) return;
    const size = run.size * geometry.scale;
    const primary = await fontFor(run.font);
    const fallback = await fontFor("fallback");
    const color = rgb(...run.color);
    const y = toY(pageTop, run.baseline);
    let x = toX(run.left);
    // Split into stretches set in one font: the face, or the fallback for
    // what the face lacks — as the browser did. A character neither has is
    // left out (it would only draw as a box).
    let segment = "";
    let segmentFont: PDFFont | null = null;
    const flush = () => {
      if (segment && segmentFont) {
        // Text render mode 3 — as in a scanned page's OCR layer — draws
        // nothing but keeps the text.
        if (run.invisible) page.pushOperators(pushGraphicsState(), setTextRenderingMode(TextRenderingMode.Invisible));
        page.drawText(segment, { x, y, size, font: segmentFont, color });
        if (run.invisible) page.pushOperators(popGraphicsState());
        x += segmentFont.widthOfTextAtSize(segment, size);
      }
      segment = "";
    };
    for (const char of text) {
      const code = char.codePointAt(0)!;
      const font = primary.glyphs.has(code) ? primary.font : fallback.glyphs.has(code) ? fallback.font : null;
      if (!font) continue;
      if (font !== segmentFont) {
        flush();
        segmentFont = font;
      }
      segment += char;
    }
    flush();
  };

  const drawImage = async (page: PDFPage, box: ImageBox, pageTop: number) => {
    let width = box.width * geometry.scale;
    let height = box.height * geometry.scale;
    const image = await imageFor(box.source, width, height);
    if (!image) return;
    let x = toX(box.left);
    let y = toY(pageTop, box.top) - height;
    if (box.fit === "contain") {
      const fit = Math.min(width / image.width, height / image.height);
      x += (width - image.width * fit) / 2;
      y += (height - image.height * fit) / 2;
      width = image.width * fit;
      height = image.height * fit;
    }
    page.drawImage(image, { x, y, width, height });
  };

  for (const chapter of input.chapters) {
    const firstPage = pages.length;
    anchors.set(chapter.path, { pageIndex: firstPage, y: geometry.height });

    if (chapter.fullPageImage) {
      // A cover or plate: as large as the page allows, centred.
      const page = pdf.addPage([geometry.width, geometry.height]);
      pages.push(page);
      const image = await imageFor(chapter.fullPageImage.source, geometry.width, geometry.height);
      if (image) {
        const fit = Math.min(geometry.width / image.width, geometry.height / image.height);
        const width = image.width * fit;
        const height = image.height * fit;
        page.drawImage(image, { x: (geometry.width - width) / 2, y: (geometry.height - height) / 2, width, height });
      }
      for (const id of chapter.anchors.keys()) anchors.set(`${chapter.path}#${id}`, { pageIndex: firstPage, y: geometry.height });
      continue;
    }

    const tops = paginate(
      [
        ...chapter.texts.map((run) => ({ top: run.top, bottom: run.bottom, keepWithNext: run.keepWithNext })),
        ...chapter.images.map((box) => ({ top: box.top, bottom: box.top + box.height })),
      ],
      column.height,
      chapter.breaks,
    );
    if (tops.length === 0) continue;
    const chapterPages = tops.map(() => {
      const page = pdf.addPage([geometry.width, geometry.height]);
      pages.push(page);
      return page;
    });

    // Shading and rules first, under the text; a box running over several
    // pages is drawn in pieces.
    for (const box of chapter.boxes) {
      for (const [index, pageTop] of tops.entries()) {
        const pageBottom = Math.min(tops[index + 1] ?? Infinity, pageTop + column.height);
        const top = Math.max(box.top, pageTop);
        const bottom = Math.min(box.top + box.height, pageBottom);
        if (bottom - top < 0.1) continue;
        chapterPages[index].drawRectangle({
          x: toX(box.left),
          y: toY(pageTop, bottom),
          width: box.width * geometry.scale,
          height: (bottom - top) * geometry.scale,
          color: rgb(...box.color),
        });
      }
    }
    for (const box of chapter.images) {
      const index = pageAt(tops, box.top);
      await drawImage(chapterPages[index], box, tops[index]);
    }
    for (const run of chapter.texts) {
      const index = pageAt(tops, run.top);
      await drawRun(chapterPages[index], run, tops[index]);
    }

    for (const [id, top] of chapter.anchors) {
      const index = pageAt(tops, top);
      anchors.set(`${chapter.path}#${id}`, {
        pageIndex: firstPage + index,
        y: Math.min(geometry.height, toY(tops[index], top) + 2),
      });
    }
    for (const link of chapter.links) {
      const index = pageAt(tops, link.top);
      const x = toX(link.left);
      const y = toY(tops[index], link.top);
      pendingLinks.push({
        pageIndex: firstPage + index,
        rect: [x, y - link.height * geometry.scale, x + link.width * geometry.scale, y],
        target: link.target,
        external: link.external,
      });
    }
    for (const heading of chapter.headings) {
      const index = pageAt(tops, heading.top);
      headings.push({
        level: heading.level,
        title: heading.title,
        dest: { pageIndex: firstPage + index, y: Math.min(geometry.height, toY(tops[index], heading.top) + 2) },
      });
    }
  }
  if (pages.length === 0) throw new Error("This EPUB has no content to read.");

  // A chapter with nothing on it lands on whatever page follows it.
  const lastPage = pages.length - 1;
  const destinationOf = (target: string | null): Destination | null => {
    if (target === null) return null;
    const dest = anchors.get(target) ?? anchors.get(target.split("#")[0]);
    return dest ? { ...dest, pageIndex: Math.min(dest.pageIndex, lastPage) } : null;
  };
  const destArray = (dest: Destination) => [
    pages[dest.pageIndex].ref,
    PDFName.of("XYZ"),
    PDFNull,
    PDFNumber.of(dest.y),
    PDFNull,
  ];

  // ---- Links ----
  for (const link of pendingLinks) {
    let action: Record<string, unknown>;
    if (link.external) {
      action = { A: pdf.context.obj({ Type: "Action", S: "URI", URI: PDFString.of(link.target) }) };
    } else {
      const dest = destinationOf(link.target);
      if (!dest) continue;
      action = { Dest: destArray(dest) };
    }
    const annotation = pdf.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: link.rect,
      Border: [0, 0, 0],
      ...action,
    } as Parameters<typeof pdf.context.obj>[0]);
    pages[link.pageIndex].node.addAnnot(pdf.context.register(annotation));
  }

  // ---- Outline: the book's table of contents, else its headings ----
  interface OutlineItem {
    title: string;
    dest: Destination | null;
    children: OutlineItem[];
  }
  const fromToc = (entries: TocEntry[]): OutlineItem[] =>
    entries.map((entry) => ({ title: entry.title, dest: destinationOf(entry.target), children: fromToc(entry.children) }));
  let outline = fromToc(input.toc).filter(function useful(item): boolean {
    item.children = item.children.filter(useful);
    return item.dest !== null || item.children.length > 0;
  });
  if (outline.length === 0) outline = outlineFromHeadings(headings);
  if (outline.length > 0) {
    const outlineRef = pdf.context.nextRef();
    const build = (items: OutlineItem[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
      const refs = items.map(() => pdf.context.nextRef());
      items.forEach((item, i) => {
        const fields: Record<string, unknown> = { Title: PDFHexString.fromText(item.title), Parent: parent };
        if (i > 0) fields.Prev = refs[i - 1];
        if (i < items.length - 1) fields.Next = refs[i + 1];
        if (item.dest) fields.Dest = destArray(item.dest);
        if (item.children.length > 0) {
          const { first, last } = build(item.children, refs[i]);
          fields.First = first;
          fields.Last = last;
          fields.Count = -item.children.length; // closed
        }
        pdf.context.assign(refs[i], pdf.context.obj(fields as Parameters<typeof pdf.context.obj>[0]));
      });
      return { first: refs[0], last: refs[refs.length - 1] };
    };
    const { first, last } = build(outline, outlineRef);
    pdf.context.assign(outlineRef, pdf.context.obj({ Type: "Outlines", First: first, Last: last, Count: outline.length }));
    pdf.catalog.set(PDFName.of("Outlines"), outlineRef);
  }

  return pdf.save();
}

// Nests headings by level: each one under the closest heading before it of
// a higher level.
function outlineFromHeadings(headings: { level: number; title: string; dest: Destination }[]) {
  interface Item {
    title: string;
    dest: Destination;
    children: Item[];
    level: number;
  }
  const roots: Item[] = [];
  const stack: Item[] = [];
  // h1–h3 only: below that a book's "headings" are run-in labels.
  for (const heading of headings.filter((h) => h.level <= 3)) {
    const item: Item = { ...heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) stack.pop();
    (stack.length > 0 ? stack[stack.length - 1].children : roots).push(item);
    stack.push(item);
  }
  return roots;
}
