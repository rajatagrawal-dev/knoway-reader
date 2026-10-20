// Paths inside an EPUB's zip: every href in the book (spine items, images,
// stylesheets, links, table-of-contents entries) is relative to the file it
// appears in and URL-encoded, while zip entries are plain paths from the
// archive's root. Pure, so the resolving can be unit-tested.

// The directory part of a zip path, with its trailing slash ("" at the root).
export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash + 1);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part; // a stray "%" that isn't an escape
  }
}

// `href` (as written in `fromFile`) as a zip path plus its fragment, or null
// for a link out of the book (http:, mailto:, …). An href that's only a
// fragment points into `fromFile` itself.
export function resolveHref(fromFile: string, href: string): { path: string; fragment: string } | null {
  const trimmed = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const hash = trimmed.indexOf("#");
  const rawPath = hash < 0 ? trimmed : trimmed.slice(0, hash);
  const fragment = hash < 0 ? "" : decode(trimmed.slice(hash + 1));
  const query = rawPath.indexOf("?");
  const pathPart = query < 0 ? rawPath : rawPath.slice(0, query);
  if (!pathPart) return { path: fromFile, fragment };
  const joined = pathPart.startsWith("/") ? pathPart.slice(1) : dirname(fromFile) + pathPart;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(decode(part));
  }
  return { path: parts.join("/"), fragment };
}

// The key a position in the book is known by: "Text/ch03.xhtml" for the
// start of a file, "Text/ch03.xhtml#sec-2" for an element in it.
export function anchorKey(path: string, fragment = ""): string {
  return fragment ? `${path}#${fragment}` : path;
}

// Looks a path up in the archive, forgiving the case mismatches some
// producers leave between the manifest and the zip.
export function findEntry<T>(files: Map<string, T>, path: string): string | null {
  if (files.has(path)) return path;
  const lower = path.toLowerCase();
  for (const name of files.keys()) if (name.toLowerCase() === lower) return name;
  return null;
}

// What an image file is, from its first bytes — manifests are often wrong
// about it, and pdf-lib only takes JPEG and PNG as they are.
export function sniffImageType(bytes: Uint8Array): "jpeg" | "png" | "gif" | "webp" | "svg" | "other" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    return "webp";
  }
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  if (head.startsWith("<!doctype svg") || head.includes("<svg")) return "svg";
  return "other";
}

export function mimeTypeOf(path: string, bytes?: Uint8Array): string {
  const sniffed = bytes ? sniffImageType(bytes) : "other";
  if (sniffed === "jpeg") return "image/jpeg";
  if (sniffed === "svg") return "image/svg+xml";
  if (sniffed !== "other") return `image/${sniffed}`;
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    css: "text/css",
  };
  return byExt[ext] ?? "application/octet-stream";
}

// Stylesheets are inlined into the page that lays the book out; anything
// they'd fetch (web fonts, background images) is dropped — the book is set
// in the reader's own fonts, and only the content's images are drawn.
export function sanitizeCss(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@font-face\s*\{[^}]*\}/gi, "")
    .replace(/@import[^;]*;/gi, "")
    .replace(/url\((?:[^()"']|"[^"]*"|'[^']*')*\)/gi, "none");
}

// @import targets of a stylesheet, in order, so they can be inlined ahead of
// it (sanitizeCss drops the rules themselves).
export function cssImports(css: string): string[] {
  const imports: string[] = [];
  const pattern = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi;
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(pattern)) imports.push(match[1]);
  return imports;
}
