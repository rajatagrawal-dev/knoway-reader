// Small, pure pieces of reading a page: what kind of file came back, the
// text encoding of an HTML page, and which picture of a srcset to use.

export type ResourceKind = "pdf" | "epub" | "html" | "text" | "image" | "other";

// What a fetched resource is, by its bytes first and its Content-Type
// second — servers mislabel files often enough.
export function classifyResource(contentType: string, bytes: Uint8Array): ResourceKind {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const head = new TextDecoder("latin1").decode(bytes.subarray(bom, bom + 1024));
  // "%PDF-", by its bytes: the desktop app serves a script whose first
  // kilobyte contains that text as a PDF (see vite.config.ts).
  if ([0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, i) => bytes[bom + i] === byte)) return "pdf";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && head.includes("mimetypeapplication/epub+zip")) return "epub";
  if (type === "application/pdf") return "pdf";
  if (type === "application/epub+zip") return "epub";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (/^\s*(<!--[\s\S]*?-->\s*)*<(!doctype\s+html|html|head|body)\b/i.test(head)) return "html";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("text/") || type === "application/xml" || type === "application/json") return "text";
  return "other";
}

function charsetFromContentType(contentType: string): string | null {
  const match = contentType.match(/charset\s*=\s*["']?([^"';\s]+)/i);
  return match ? match[1] : null;
}

// An HTML page's bytes as text, in the encoding it declares: a byte-order
// mark, then the Content-Type header, then a <meta> in its first bytes,
// else UTF-8.
export function decodeHtml(bytes: Uint8Array, contentType = ""): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const declared =
    charsetFromContentType(contentType) ??
    head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i)?.[1] ??
    null;
  if (declared) {
    try {
      return new TextDecoder(declared.toLowerCase()).decode(bytes);
    } catch {
      // An encoding the browser doesn't know: UTF-8 is the best guess.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// ---- srcset ---------------------------------------------------------------------

export interface SrcsetCandidate {
  url: string;
  width?: number; // "800w"
  density?: number; // "2x"
}

// Parses a srcset the way browsers do: a URL is a run of non-spaces (commas
// included — image CDNs put them in paths), and its descriptors run to the
// next comma.
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(srcset[i])) i += 1;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(srcset[i])) i += 1;
    let url = srcset.slice(start, i);
    let descriptors = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      start = i;
      let depth = 0;
      while (i < n && (srcset[i] !== "," || depth > 0)) {
        if (srcset[i] === "(") depth += 1;
        if (srcset[i] === ")") depth = Math.max(0, depth - 1);
        i += 1;
      }
      descriptors = srcset.slice(start, i).trim();
      i += 1; // the comma
    }
    if (!url) continue;
    const candidate: SrcsetCandidate = { url };
    for (const descriptor of descriptors.split(/\s+/).filter(Boolean)) {
      const value = parseFloat(descriptor);
      if (!Number.isFinite(value) || value <= 0) continue;
      if (/w$/i.test(descriptor)) candidate.width = value;
      else if (/x$/i.test(descriptor)) candidate.density = value;
    }
    candidates.push(candidate);
  }
  return candidates;
}

// The candidate to save: the sharpest one up to `targetWidth` pixels wide
// (enough for a page of the book, zoomed in), else the smallest above it;
// for density descriptors, 2x where offered.
export function pickSrcsetCandidate(candidates: SrcsetCandidate[], targetWidth = 1600): SrcsetCandidate | null {
  if (candidates.length === 0) return null;
  const widths = candidates.filter((c) => c.width);
  if (widths.length > 0) {
    const fitting = widths.filter((c) => c.width! <= targetWidth).sort((a, b) => b.width! - a.width!);
    if (fitting.length > 0) return fitting[0];
    return [...widths].sort((a, b) => a.width! - b.width!)[0];
  }
  const byDensity = [...candidates].sort((a, b) => (a.density ?? 1) - (b.density ?? 1));
  return byDensity.find((c) => (c.density ?? 1) >= 2) ?? byDensity[byDensity.length - 1];
}

// A src that stands in until a script swaps the real picture in: a tiny
// data: image, or one named like a placeholder.
export function isPlaceholderSrc(src: string | null | undefined): boolean {
  if (!src || !src.trim()) return true;
  const value = src.trim();
  if (/^data:/i.test(value)) return value.length < 400 || /^data:image\/svg\+xml/i.test(value) && !/<(path|rect|circle|text|image)\b/i.test(decodeURIComponentSafe(value));
  return /(^|[/_.-])(placeholder|blank|spacer|transparent|pixel|lazy|loading|1x1|grey|gray)([._-]|\.(gif|png|svg|jpe?g)|$)/i.test(
    value.split("?")[0],
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Whitespace collapsed, ends trimmed.
export function normalizeText(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

// CSS.escape where there is one (browsers), else enough of it for an id in
// an attribute selector.
export function escapeCss(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\[\]]/g, "\\$&");
}
