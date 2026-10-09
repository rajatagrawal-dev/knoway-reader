import type { DocumentTextIndex, IndexedPage } from "../glossary/textIndex.ts";
import { locateSelection } from "./context.ts";
import type { SourceRef } from "./types.ts";

// What the reader added to their question ("Add to question"): text from the
// PDF or from an earlier AI answer, or a region of a page (an area
// selection or highlight). Document text becomes a source the answer can
// cite — located on its page so its chip can jump there; answer text is
// context only, since it isn't the document. A region goes as an image, so
// the model sees a figure or equation as drawn, and whatever text the PDF
// has inside it becomes a citable source too.

export interface RegionImage {
  mediaType: string;
  data: string; // base64, no data: URL prefix
}

export interface Attachment {
  id: string;
  kind: "document" | "answer" | "region";
  text: string; // region: the PDF text inside it, possibly ""
  pageNumber?: number; // document and region attachments: the page it's on
  truncated?: boolean; // cut to ATTACHMENT_MAX_CHARS
  image?: RegionImage; // region
  range?: [number, number]; // region: its text's [start, end) in the page text
}

// A region of a page, in the same scaled coordinates as a highlight's
// boundingRect (x/y measured against that page's width/height).
export interface RegionRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
}

// One selection can't swamp the request: a few paragraphs each, a handful in all.
export const ATTACHMENT_MAX_CHARS = 3000;
export const MAX_ATTACHMENTS = 5;

export function makeAttachment(kind: Attachment["kind"], text: string, pageNumber?: number): Attachment | null {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const truncated = clean.length > ATTACHMENT_MAX_CHARS;
  return {
    id: crypto.randomUUID(),
    kind,
    text: truncated ? `${clean.slice(0, ATTACHMENT_MAX_CHARS)}…` : clean,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

// The page text inside a region, as one [start, end) span of the page text
// (from the first character inside to the last). Decided per character:
// its line must sit mostly inside the region vertically, and the character
// itself inside it horizontally — so a box drawn around part of a wide line
// takes just that part. (pdf.js gives one rect per text run, so a
// character's x is interpolated across its run, as matchPosition does.)
// Null when the region holds no text: a picture, or math the PDF only draws.
export function regionTextRange(page: IndexedPage, rect: RegionRect): [number, number] | null {
  const left = (rect.x1 / rect.width) * page.width;
  const right = (rect.x2 / rect.width) * page.width;
  const top = (rect.y1 / rect.height) * page.height;
  const bottom = (rect.y2 / rect.height) * page.height;
  let start = -1;
  let end = -1;
  page.charItem.forEach((itemIndex, char) => {
    if (itemIndex < 0) return;
    const item = page.items[itemIndex];
    const { left: itemLeft, top: itemTop, width, height } = item.rect;
    const overlap = Math.min(bottom, itemTop + height) - Math.max(top, itemTop);
    if (!(height > 0) || overlap < height / 2) return;
    const x = itemLeft + ((page.charOffset[char] + 0.5) / Math.max(1, item.text.length)) * width;
    if (x < left || x > right) return;
    if (start === -1) start = char;
    end = char + 1;
  });
  if (start === -1) return null;
  while (start < end && page.text[start] === " ") start += 1;
  while (end > start && page.text[end - 1] === " ") end -= 1;
  return end > start ? [start, end] : null;
}

export function makeRegionAttachment(
  image: RegionImage,
  pageNumber: number,
  page: IndexedPage | null,
  rect: RegionRect,
): Attachment {
  const range = page ? regionTextRange(page, rect) : null;
  const text = range && page ? page.text.slice(range[0], range[1]).slice(0, ATTACHMENT_MAX_CHARS) : "";
  return {
    id: crypto.randomUUID(),
    kind: "region",
    text,
    pageNumber,
    image,
    ...(range && text ? { range: [range[0], range[0] + text.length] as [number, number] } : {}),
  };
}

// Adds `next` unless it's already attached; keeps at most MAX_ATTACHMENTS
// (the newest).
export function addAttachment(list: Attachment[], next: Attachment): Attachment[] {
  const same = (a: Attachment) =>
    a.kind === next.kind &&
    a.pageNumber === next.pageNumber &&
    (next.kind === "region" ? a.image?.data === next.image?.data : a.text === next.text);
  if (list.some(same)) return list;
  return [...list, next].slice(-MAX_ATTACHMENTS);
}

// The images to send with the question.
export function attachmentImages(attachments: Attachment[]): RegionImage[] {
  return attachments.flatMap((a) => (a.kind === "region" && a.image ? [a.image] : []));
}

// Document attachments as (unlabeled) sources, placed exactly on their page
// when the text can be found there. When it can't (an extraction mismatch),
// the page is still known: start = end = 0 makes a citation jump to the
// page without flashing a passage.
export function attachmentSources(attachments: Attachment[], index: DocumentTextIndex | null): SourceRef[] {
  return attachments.flatMap((attachment): SourceRef[] => {
    if (attachment.kind === "region") {
      // Its text, if the region had any: already located when it was added.
      if (!attachment.range || !attachment.text || attachment.pageNumber === undefined) return [];
      const [start, end] = attachment.range;
      return [{ label: "", pageNumber: attachment.pageNumber, start, end, text: attachment.text }];
    }
    if (attachment.kind !== "document" || attachment.pageNumber === undefined) return [];
    const page = index?.pages[attachment.pageNumber - 1];
    const range = page ? locateSelection(index!, attachment.pageNumber, attachment.text.replace(/…$/, "")) : null;
    if (page && range) {
      return [{ label: "", pageNumber: attachment.pageNumber, start: range[0], end: range[1], text: page.text.slice(range[0], range[1]) }];
    }
    return [{ label: "", pageNumber: attachment.pageNumber, start: 0, end: 0, text: attachment.text }];
  });
}

// Whether `source` is (part of) one of the attached passages — attached
// sources are always sent, so a retrieved chunk overlapping one is dropped.
export function overlapsAny(source: SourceRef, attached: SourceRef[]): boolean {
  return attached.some(
    (a) => a.pageNumber === source.pageNumber && a.end > a.start && a.start < source.end && source.start < a.end,
  );
}

// For the system prompt: which sources the reader attached, any page regions
// sent as images, and any quoted answer text (context only).
export function attachmentInstructions(
  attachments: Attachment[],
  attachedLabels: string[],
  pageLabel: (pageNumber: number) => string = String,
): string {
  const lines: string[] = [];
  const regions = attachments.filter((a) => a.kind === "region" && a.image);
  if (regions.length) {
    const pages = [...new Set(regions.map((a) => `p. ${pageLabel(a.pageNumber ?? 0)}`))].join(", ");
    lines.push(
      `The reader attached ${regions.length === 1 ? "an image of a region" : `${regions.length} images of regions`} of the document (${pages}), sent with their message. Read ${regions.length === 1 ? "it" : "them"} for what the text can't show — figures, equations, tables.`,
    );
  }
  if (attachedLabels.length) {
    lines.push(`The reader attached ${attachedLabels.join(", ")} to their question: answer about ${attachedLabels.length > 1 ? "those" : "that"} first.`);
  }
  const quoted = attachments.filter((a) => a.kind === "answer");
  if (quoted.length) {
    lines.push(
      `The reader also quoted this from an earlier explanation (context only — not a source, don't cite it):\n${quoted
        .map((a) => `"""\n${a.text}\n"""`)
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}

// Extra search words for finding related passages elsewhere.
export function attachmentQuery(attachments: Attachment[]): string {
  return attachments.map((a) => a.text.slice(0, 400)).join(" ");
}

// How an attachment reads in a chip: "p. 42 · “The first words…”",
// "p. 42 · Region".
export function attachmentLabel(attachment: Attachment, pageLabel: (pageNumber: number) => string): string {
  if (attachment.kind === "region") return `p. ${pageLabel(attachment.pageNumber ?? 0)} · Region`;
  const where = attachment.kind === "document" && attachment.pageNumber !== undefined ? `p. ${pageLabel(attachment.pageNumber)}` : "From answer";
  const snippet = attachment.text.length > 48 ? `${attachment.text.slice(0, 47)}…` : attachment.text;
  return `${where} · “${snippet}”`;
}
