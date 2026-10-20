import { unzipSync } from "fflate";
import { anchorKey, findEntry, resolveHref } from "./paths.ts";

// An EPUB, unpacked: its files, its reading order (the spine), its table of
// contents and the details the library shows. EPUB 2 and 3 both — the
// table of contents comes from the EPUB 3 nav document when there is one,
// else from the EPUB 2 NCX.

export interface TocEntry {
  title: string;
  target: string | null; // an anchorKey into the book, or null for a heading with no link
  children: TocEntry[];
}

export interface EpubBook {
  files: Map<string, Uint8Array>;
  title?: string;
  authors: string[];
  language?: string;
  // Zip paths of the content documents in reading order; items the book
  // marks non-linear (notes, answers) come after the rest.
  spine: string[];
  toc: TocEntry[];
  coverImage?: string; // zip path of the cover picture, when the book names one
}

const parser = () => new DOMParser();

export function parseXml(text: string, type: DOMParserSupportedType = "application/xml"): Document | null {
  const doc = parser().parseFromString(text, type);
  return doc.getElementsByTagName("parsererror").length > 0 ? null : doc;
}

// Content documents should be XHTML, but plenty are sloppy enough that only
// the forgiving HTML parser reads them.
// (So does XHTML missing its namespace: parsed as XML, its elements wouldn't
// be HTML ones, and no stylesheet would apply to them.)
export function parseContentDocument(text: string): Document {
  const xhtml = parseXml(text, "application/xhtml+xml");
  if (xhtml?.documentElement.namespaceURI === "http://www.w3.org/1999/xhtml") return xhtml;
  return parser().parseFromString(text, "text/html");
}

function text(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

// Elements by local name, ignoring namespace prefixes (dc:title, opf:meta).
function byName(root: ParentNode, name: string): Element[] {
  return [...root.querySelectorAll("*")].filter((el) => el.localName === name);
}

function children(el: Element, name: string): Element[] {
  return [...el.children].filter((child) => child.localName === name);
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function linkTarget(fromFile: string, href: string | null): string | null {
  if (!href) return null;
  const resolved = resolveHref(fromFile, href);
  return resolved ? anchorKey(resolved.path, resolved.fragment) : null;
}

// The EPUB 3 nav document's <nav epub:type="toc">: nested lists of links.
function tocFromNav(doc: Document, navPath: string): TocEntry[] {
  const navs = byName(doc, "nav");
  const toc =
    navs.find((nav) => /\btoc\b/.test(nav.getAttribute("epub:type") ?? nav.getAttributeNS(null, "type") ?? "")) ??
    navs[0];
  const list = toc ? byName(toc, "ol")[0] : undefined;
  if (!list) return [];
  const visit = (ol: Element): TocEntry[] =>
    children(ol, "li").flatMap((li) => {
      const label = [...li.children].find((child) => child.localName === "a" || child.localName === "span");
      const nested = children(li, "ol")[0];
      const kids = nested ? visit(nested) : [];
      const title = cleanText(label?.textContent);
      if (!title) return kids;
      const href = label?.localName === "a" ? label.getAttribute("href") : null;
      return [{ title, target: linkTarget(navPath, href), children: kids }];
    });
  return visit(list);
}

// The EPUB 2 NCX's navMap of nested navPoints.
function tocFromNcx(doc: Document, ncxPath: string): TocEntry[] {
  const navMap = byName(doc, "navMap")[0];
  if (!navMap) return [];
  const visit = (parent: Element): TocEntry[] =>
    children(parent, "navPoint").flatMap((point) => {
      const label = children(point, "navLabel")[0];
      const title = cleanText(label ? byName(label, "text")[0]?.textContent : "");
      const content = children(point, "content")[0];
      const kids = visit(point);
      if (!title) return kids;
      return [{ title, target: linkTarget(ncxPath, content?.getAttribute("src") ?? null), children: kids }];
    });
  return visit(navMap);
}

export function readEpub(bytes: Uint8Array): EpubBook {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("This file isn't a readable EPUB (it isn't a zip archive).");
  }
  const files = new Map(Object.entries(entries).filter(([name]) => !name.endsWith("/")));

  const container = parseXml(text(files.get("META-INF/container.xml")));
  const rootfile = container ? byName(container, "rootfile")[0]?.getAttribute("full-path") : null;
  const opfPath = rootfile ? findEntry(files, rootfile) : [...files.keys()].find((name) => /\.opf$/i.test(name));
  const opf = opfPath ? parseXml(text(files.get(opfPath))) : null;
  if (!opfPath || !opf) throw new Error("This EPUB has no readable package document.");

  const metadata = byName(opf, "metadata")[0] ?? opf.documentElement;
  const title = cleanText(byName(metadata, "title")[0]?.textContent) || undefined;
  const authors = byName(metadata, "creator")
    .filter((el) => {
      // EPUB 2 marks roles inline, EPUB 3 by a refining <meta>; when no role
      // is given, a creator is an author.
      const role = el.getAttribute("opf:role") ?? el.getAttribute("role");
      return !role || role === "aut";
    })
    .map((el) => cleanText(el.textContent))
    .filter(Boolean);
  const language = cleanText(byName(metadata, "language")[0]?.textContent) || undefined;

  interface ManifestItem {
    path: string;
    mediaType: string;
    properties: string;
  }
  const manifest = new Map<string, ManifestItem>();
  for (const item of byName(opf, "item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    const resolved = href ? resolveHref(opfPath, href) : null;
    if (!id || !resolved) continue;
    manifest.set(id, {
      path: findEntry(files, resolved.path) ?? resolved.path,
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  }

  const spineEl = byName(opf, "spine")[0];
  const linear: string[] = [];
  const nonLinear: string[] = [];
  for (const ref of spineEl ? children(spineEl, "itemref") : []) {
    const item = manifest.get(ref.getAttribute("idref") ?? "");
    if (!item || !files.has(item.path)) continue;
    (ref.getAttribute("linear") === "no" ? nonLinear : linear).push(item.path);
  }
  const spine = [...new Set([...linear, ...nonLinear])];
  if (spine.length === 0) throw new Error("This EPUB has no content to read.");

  let toc: TocEntry[] = [];
  const nav = [...manifest.values()].find((item) => /\bnav\b/.test(item.properties));
  if (nav && files.has(nav.path)) toc = tocFromNav(parseContentDocument(text(files.get(nav.path))), nav.path);
  if (toc.length === 0) {
    const ncx =
      manifest.get(spineEl?.getAttribute("toc") ?? "") ??
      [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
    const ncxDoc = ncx ? parseXml(text(files.get(ncx.path))) : null;
    if (ncx && ncxDoc) toc = tocFromNcx(ncxDoc, ncx.path);
  }

  // EPUB 3 flags the cover in the manifest; EPUB 2 names it in a <meta>.
  const coverItem =
    [...manifest.values()].find((item) => /\bcover-image\b/.test(item.properties)) ??
    manifest.get(byName(metadata, "meta").find((meta) => meta.getAttribute("name") === "cover")?.getAttribute("content") ?? "");
  const coverImage =
    coverItem && coverItem.mediaType.startsWith("image/") && files.has(coverItem.path) ? coverItem.path : undefined;

  return { files, title, authors, language, spine, toc, coverImage };
}
