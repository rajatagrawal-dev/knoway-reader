import { Readability } from "@mozilla/readability";
import { normalizeText } from "./html.ts";
import { ID_ATTR, type PreparedPage } from "./prepare.ts";
import type { PageMetadata } from "./types.ts";

// Finds the article on a prepared page (prepare.ts): Mozilla's Readability
// (Firefox's Reader View) picks it out from the site around it, and then
// nothing it dropped from inside the article is taken on trust. It prunes
// by score — a code sample, a table, a figure, a short paragraph between
// two links can all score as clutter — so every passage of the original
// that lies within the stretch of the page the article came from is checked,
// and anything that reads as content (text that isn't a list of links,
// pictures, tables, code, formulas, quotes) is put back where it was.

export interface Extraction {
  content: HTMLElement; // the article, in its own document
  restoredBlocks: number;
  usedFallback: boolean; // Readability found nothing; the page's main element was taken whole
}

const BLOCKS = new Set(["p", "pre", "table", "figure", "ul", "ol", "dl", "blockquote", "h2", "h3", "h4", "h5", "h6", "img", "svg", "math", "canvas", "hr", "address", "details"]);
const CONTAINERS = new Set(["div", "section", "article", "main", "aside", "header", "footer", "span", "body", "center", "font", "li", "dd", "td", "th", "figcaption", "summary", "form"]);
const INLINE_PARENTS = new Set(["a", "span", "em", "strong", "b", "i", "u", "code", "small", "sup", "sub", "mark", "label", "abbr", "cite", "q", "s", "del", "ins", "time", "li", "dt", "dd", "td", "th", "tr", "tbody", "thead", "tfoot", "caption", "figcaption", "summary", "picture"]);

// Class and id words of the site around an article. Whole words (delimited)
// for short ones; substrings for long ones, so CSS-module names like
// "PostSidebar-module__x" are caught too. The hard ones are the site's
// wherever they appear; the soft ones only outside the stretch of the page
// the article came from — inside it, a "sidebar" or a "related work"
// section is often the article's own, and is judged by its content.
const HARD_JUNK_ROLES = /^(navigation|banner|contentinfo|search|dialog|alertdialog|menu|menubar|toolbar|tablist)$/;
const HARD_JUNK_WORDS = /(^|[\s_-])(ad|ads|advert|pagination|pager|share|social|subscribe|signup|newsletter|promo|sponsor(ed)?|popup|modal|cookie|consent|skip|print-only|comments?)([\s_-]|$)/i;
const HARD_JUNK_SUBSTRINGS = /(newsletter|subscribe|cookie|consent|breadcrumb|sharing|sharebar|share-?button|social|advert|sponsor|promo|popup|modal|paywall|signup|sign-up)/i;
const SOFT_JUNK_WORDS = /(^|[\s_-])(toc|nav|navbar|menu|tags|byline|widget|banner|masthead|related|footer|site-header)([\s_-]|$)/i;
const SOFT_JUNK_SUBSTRINGS = /(sidebar|relatedposts|related-?(articles|posts|stories|content)|recommend|table-?of-?contents|tableofcontents)/i;
// The end matter of an article — notes, references, further reading —
// often sits outside the element the article's body is in.
const APPENDIX_HEADINGS = /^(foot ?notes|notes|end ?notes|references|bibliography|works cited|sources|citations|further reading|see also|acknowledge?ments?|authors? (and|&) acknowledge?ments?|appendix|appendices|credits|errata)\b/i;
const JUNK_HEADINGS = /^(share|related|comments?|subscribe|newsletter|tags|topics|read more|more from|more in|you (might|may) also like|recommended|popular|trending|about the author|sign up|follow us|table of contents|contents|on this page|in this article)\b/i;

function idOf(el: Element | null): string | null {
  return el?.getAttribute(ID_ATTR) ?? null;
}

function isJunkElement(el: Element, soft = true): boolean {
  const tag = el.localName;
  if (tag === "nav" || tag === "button" || tag === "dialog" || tag === "select" || tag === "input" || tag === "textarea") return true;
  if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return true;
  if (/display\s*:\s*none/i.test(el.getAttribute("style") ?? "")) return true;
  const role = el.getAttribute("role") ?? "";
  if (HARD_JUNK_ROLES.test(role) || (soft && role === "complementary")) return true;
  const names = `${el.getAttribute("class") ?? ""} ${el.getAttribute("id") ?? ""}`;
  if (HARD_JUNK_WORDS.test(names) || HARD_JUNK_SUBSTRINGS.test(names)) return true;
  return soft && (SOFT_JUNK_WORDS.test(names) || SOFT_JUNK_SUBSTRINGS.test(names));
}

function inJunk(el: Element, soft: boolean): boolean {
  for (let node: Element | null = el; node && node.localName !== "body"; node = node.parentElement) {
    if (isJunkElement(node, soft)) return true;
  }
  return false;
}

// A note, tip, warning or boxed sidebar in the text: kept whole, label and all.
const CALLOUT = /(^|[\s_-])(admonition|callout|note|notice|tip|hint|warning|caution|important|danger|info-?box|sidebar|aside|alert|seealso|box)([\s_-]|$)/i;

function isCallout(el: Element): boolean {
  if (el.hasAttribute("data-kr-callout") || el.localName === "aside") return true;
  return /^(div|section)$/.test(el.localName) && CALLOUT.test(el.getAttribute("class") ?? "");
}

function linkDensity(el: Element): number {
  const text = normalizeText(el.textContent).length;
  if (text === 0) return 0;
  let linked = 0;
  for (const a of el.querySelectorAll("a")) linked += normalizeText(a.textContent).length;
  return linked / text;
}

function ownText(el: Element): number {
  let length = 0;
  for (const node of el.childNodes) if (node.nodeType === 3) length += normalizeText(node.textContent).length;
  return length;
}

function declaredSize(el: Element): { width: number; height: number } {
  const width = parseFloat(el.getAttribute("width") ?? "");
  const height = parseFloat(el.getAttribute("height") ?? "");
  return { width: Number.isFinite(width) ? width : NaN, height: Number.isFinite(height) ? height : NaN };
}

function similar(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const y = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return x.length > 0 && (x === y || (x.length > 20 && (x.includes(y) || y.includes(x))));
}

// Would a reader count this as part of the article? `strict` for what lies
// outside the stretch the article came from (before its first passage or
// after its last), where a site's own furniture usually sits.
function isContent(el: Element, title: string, strict: boolean, appendix = false): boolean {
  const tag = el.localName;
  const text = normalizeText(el.textContent);
  if (el.hasAttribute("data-kr-island") || el.hasAttribute("data-kr-math")) return !strict || el.hasAttribute("data-kr-island");
  if (el.hasAttribute("data-kr-media")) return true;
  if (tag === "img") {
    if (!el.getAttribute("src")) return false;
    const { width, height } = declaredSize(el);
    if (width <= 64 && height <= 64) return false; // an avatar, an icon
    if (strict) return width >= 300 || (Number.isNaN(width) && el.closest("figure") !== null);
    return el.closest("a") === null || !(width < 150);
  }
  if (tag === "svg") {
    if (el.closest("a, button")) return false;
    const { width, height } = declaredSize(el);
    const box = (el.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
    const w = Number.isFinite(width) ? width : box[2];
    const h = Number.isFinite(height) ? height : box[3];
    return !(w <= 48 && h <= 48) && !strict;
  }
  if (tag === "figure") return el.querySelector("img[src], svg, [data-kr-island], [data-kr-media], table, pre") !== null || (!strict && text.length >= 30);
  if (tag === "pre" || tag === "table" || tag === "math" || tag === "canvas") return text.length > 0 || tag === "canvas";
  if (tag === "hr") return false;
  if (/^h[2-6]$/.test(tag) && APPENDIX_HEADINGS.test(text)) return true;
  if (/^h[2-6]$/.test(tag)) return !strict && text.length >= 2 && text.length <= 200 && !similar(text, title) && !JUNK_HEADINGS.test(text);
  if (tag === "blockquote") return text.length >= 20 && linkDensity(el) < (strict ? 0.5 : 0.9);
  if (tag === "ul" || tag === "ol" || tag === "dl") {
    if (appendix) return text.length >= 10; // references, further reading: links are the point
    if (strict) return text.length >= 120 && linkDensity(el) < 0.3;
    // A list of links is navigation (a table of contents, related posts)
    // unless its items say something (references, further reading).
    const items = el.querySelectorAll(":scope > li, :scope > dt, :scope > dd").length || 1;
    return text.length >= 20 && (linkDensity(el) < 0.7 || text.length / items > 60);
  }
  if (isCallout(el)) return text.length >= 20 && linkDensity(el) < (strict ? 0.3 : 0.7);
  // Paragraphs, and containers with text of their own. Inside the article
  // a paragraph that's mostly a link ("See also: …") is still the article's.
  if (text.length < (strict ? 80 : 25) || linkDensity(el) >= (strict ? 0.3 : 0.9)) return false;
  if (strict && !/[.!?:;]/.test(text)) return false;
  return true;
}

// Elements of the original page are numbered in document order when it's
// read (prepare.ts's tagElements), so their numbers say which comes first —
// an ancestor before its descendants, as in compareDocumentPosition.
function precedes(a: Node, b: Node): boolean {
  const x = Number((a as Element).getAttribute?.(ID_ATTR) ?? NaN);
  const y = Number((b as Element).getAttribute?.(ID_ATTR) ?? NaN);
  if (Number.isFinite(x) && Number.isFinite(y)) return x < y;
  return (a.compareDocumentPosition(b) & 4) !== 0; // DOCUMENT_POSITION_FOLLOWING
}

// The page's own content element taken whole, for when Readability finds no
// article: everything but its navigation and the like.
function conservativeContent(prepared: Document, out: Document): HTMLElement {
  const root =
    prepared.querySelector("article [itemprop=articleBody], [itemprop=articleBody], main article, article, main, [role=main]") ??
    prepared.body;
  const copy = out.importNode(root, true) as HTMLElement;
  for (const el of [...copy.querySelectorAll("*")]) {
    if (!copy.contains(el)) continue; // inside something already removed
    if (el.closest("pre, code")) continue; // a highlighter's "comment" span is code
    if (isJunkElement(el) || /^(header|footer|form|script|style|noscript)$/.test(el.localName)) el.remove();
  }
  const container = out.createElement("div");
  container.append(copy);
  return container;
}

export function extractArticle(prepared: PreparedPage, meta: PageMetadata): Extraction {
  const source = prepared.doc;
  const clone = source.cloneNode(true) as Document;
  let content: HTMLElement | null = null;
  try {
    const result = new Readability<Node>(clone, {
      keepClasses: true, // cleaned later; the class names still tell clutter apart
      serializer: (node) => node,
      charThreshold: 400,
    }).parse();
    content = (result?.content as HTMLElement | null | undefined) ?? null;
  } catch (error) {
    console.warn("Readability failed:", error);
  }

  let usedFallback = false;
  if (!content || normalizeText(content.textContent).length < 140) {
    const out = content?.ownerDocument ?? clone;
    const fallback = conservativeContent(source, out);
    if (!content || normalizeText(fallback.textContent).length > normalizeText(content.textContent).length) {
      content = fallback;
      usedFallback = true;
    }
  }
  const restoredBlocks = usedFallback ? 0 : restoreDropped(source, content, meta) + repairKeptBlocks(source, content);
  addLeadImage(source, content, meta);
  return { content, restoredBlocks, usedFallback };
}

function restoreDropped(source: Document, content: HTMLElement, meta: PageMetadata): number {
  const out = content.ownerDocument;
  const outById = new Map<string, Element>();
  for (const el of [content, ...content.querySelectorAll(`[${ID_ATTR}]`)]) {
    const id = idOf(el);
    if (id && !outById.has(id)) outById.set(id, el);
  }
  const byId = new Map<string, Element>();
  for (const el of source.querySelectorAll(`[${ID_ATTR}]`)) byId.set(idOf(el)!, el);

  const kept = [...outById.keys()]
    .map((id) => byId.get(id))
    .filter((el): el is Element => !!el && el.localName !== "body" && el.localName !== "html");
  if (kept.length === 0) return 0;
  let first = kept[0];
  let last = kept[0];
  for (const el of kept) {
    if (precedes(el, first)) first = el;
    if (precedes(last, el)) last = el;
  }
  const isKept = (el: Element) => outById.has(idOf(el) ?? "");
  const hasKeptAncestor = (el: Element) => {
    for (let node = el.parentElement; node && node.localName !== "body"; node = node.parentElement) if (isKept(node)) return true;
    return false;
  };
  // The stretch of the page the article came from: from the first element
  // Readability kept to the last.
  const inSpan = (el: Element) => (first === el || first.contains(el) || precedes(first, el)) && (precedes(el, last) || last.contains(el) || hasKeptAncestor(el));

  // Outside that span, only the semantic element the article sits in is
  // searched: an <article> (whose content is the article's, so it's judged
  // as such — a closing "Acknowledgements" section, say), or failing that
  // <main>, more strictly. Either way, not its header, footer, asides or
  // navigation: the title block, tags, sharing, related links.
  let region: Element | null = first.closest("[itemprop=articleBody], article, main, [role=main]");
  if (region && !region.contains(last)) region = null;
  const regionIsArticle = region !== null && region.matches("[itemprop=articleBody], article");
  const inRegionFurniture = (el: Element) => {
    const furniture = el.closest("header, footer, aside, nav");
    return furniture !== null && region !== null && region.contains(furniture) && furniture !== region;
  };

  // Within a section headed as end matter, judged as the article's own.
  const inAppendix = (el: Element) => {
    for (let node = el.parentElement; node && node !== region && node.localName !== "body"; node = node.parentElement) {
      const heading = node.querySelector(":scope > h2, :scope > h3, :scope > h4, :scope > header > h2, :scope > header > h3");
      if (heading && APPENDIX_HEADINGS.test(normalizeText(heading.textContent))) return true;
    }
    return false;
  };

  const restored: Element[] = [];
  const walker = source.createTreeWalker(source.body, 1); // NodeFilter.SHOW_ELEMENT
  let skipUntilOutside: Element | null = null;
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    if (skipUntilOutside && skipUntilOutside.contains(node)) continue;
    skipUntilOutside = null;
    // Made while preparing the page (a figure's placeholder picture, a video
    // card's caption, a formula's wrapper): not judged on its own — it goes
    // wherever the element it belongs to goes — though what it holds may be.
    if (!idOf(node)) continue;
    if (isKept(node)) continue;
    const span = inSpan(node);
    if (!span && !(region && region.contains(node))) continue;
    if (!span && inRegionFurniture(node)) {
      skipUntilOutside = node;
      continue;
    }
    const appendix = inAppendix(node);
    const strict = !span && !regionIsArticle && !appendix;
    if (inJunk(node, !span)) {
      skipUntilOutside = node;
      continue;
    }
    const tag = node.localName;
    const atomic =
      BLOCKS.has(tag) ||
      (isCallout(node) && normalizeText(node.textContent).length <= 3000) ||
      node.hasAttribute("data-kr-island") ||
      node.hasAttribute("data-kr-media") ||
      node.getAttribute("data-kr-math") === "display" ||
      (CONTAINERS.has(tag) && ownText(node) >= 25 && !node.querySelector("p, div, section, ul, ol, table, pre, figure, h2, h3, h4, h5, h6"));
    if (!atomic) continue; // look inside it
    if (!INLINE_PARENTS.has(tag) || tag === "li" || tag === "dd" || tag === "td" || isCallout(node) || node.getAttribute("data-kr-math") === "display") {
      if (isContent(node, meta.title, strict, appendix)) {
        restored.push(node);
        skipUntilOutside = node;
      } else if (BLOCKS.has(tag)) {
        skipUntilOutside = node; // clutter as a whole
      }
    }
  }

  // A short label just before a restored passage ("Note", "See also")
  // comes back with it.
  for (const block of [...restored]) {
    const label = block.previousElementSibling;
    if (!label || !idOf(label) || isKept(label) || restored.includes(label)) continue;
    const text = normalizeText(label.textContent);
    if (/^(p|div|span|strong|b|dt)$/.test(label.localName) && text.length >= 2 && text.length <= 60 && !inJunk(label, !inSpan(label)) && linkDensity(label) < 0.5) {
      restored.splice(restored.indexOf(block), 0, label);
    }
  }

  // A heading comes back only to introduce something that's in the
  // article ("Chapter 01: …" in a sticky bar heads nothing).
  const restoredSet = new Set(restored);
  // (Through any subheadings: "Authors & Acknowledgments" › "Acknowledgements" › text.)
  const introducesContent = (heading: Element) => {
    const level = Number(heading.localName[1]);
    const after = source.createTreeWalker(source.body, 1);
    after.currentNode = heading;
    let steps = 0;
    for (let node = after.nextNode() as Element | null; node && steps < 60; node = after.nextNode() as Element | null) {
      if (heading.contains(node)) continue;
      steps += 1;
      const isHeading = /^h[1-6]$/.test(node.localName);
      if (isHeading && Number(node.localName[1]) <= level) return false;
      if (!isHeading && (isKept(node) || restoredSet.has(node))) return true;
    }
    return false;
  };
  const accepted = restored.filter((block) => !/^h[2-6]$/.test(block.localName) || introducesContent(block));
  // Nothing twice: the extractor sometimes rebuilds an element (losing its
  // id) rather than dropping it, and a page may repeat itself (footnotes
  // shown both beside the text and at its end).
  let outText = normalizeText(content.textContent);
  const outPictures = new Set([...content.querySelectorAll("img[src]")].map((img) => img.getAttribute("src")));
  let count = 0;
  for (const block of accepted) {
    const text = normalizeText(block.textContent);
    const pictures = [...(block.localName === "img" ? [block] : block.querySelectorAll("img[src]"))].map((img) => img.getAttribute("src"));
    const textThere = text.length >= 30 && outText.includes(text);
    const picturesThere = pictures.length > 0 && pictures.every((src) => outPictures.has(src));
    if ((textThere && (pictures.length === 0 || picturesThere)) || (text.length < 30 && picturesThere)) continue;
    insertRestored(block, out, outById, byId, content);
    outText += ` ${text}`;
    pictures.forEach((src) => outPictures.add(src));
    count += 1;
  }
  return count;
}

// Readability also takes things out of the middle of passages it keeps —
// any element whose class looks unlikely to it ("popup", "comment", "share"),
// such as Wikipedia's pronunciation guides ("nopopups"). Every kept passage
// is compared with the original, and one that lost words gets its original
// content back — less only what's hidden or a control.
const PASSAGES = "p, li, dt, dd, td, th, h1, h2, h3, h4, h5, h6, figcaption, caption, blockquote, summary, pre";

function structurallyHidden(el: Element): boolean {
  return (
    /^(button|input|select|textarea|script|style|noscript|template)$/.test(el.localName) ||
    el.hasAttribute("hidden") ||
    el.getAttribute("aria-hidden") === "true" ||
    /display\s*:\s*none/i.test(el.getAttribute("style") ?? "")
  );
}

function repairKeptBlocks(source: Document, content: HTMLElement): number {
  const out = content.ownerDocument;
  let repaired = 0;
  for (const el of [...content.querySelectorAll(PASSAGES)]) {
    if (!content.contains(el)) continue; // replaced along with an outer passage
    const id = idOf(el);
    const original = id ? source.querySelector(`[${ID_ATTR}="${id}"]`) : null;
    if (!original || original.localName !== el.localName) continue;
    const copy = out.importNode(original, true) as Element;
    for (const hidden of [...copy.querySelectorAll("*")].filter(structurallyHidden)) hidden.remove();
    const had = normalizeText(copy.textContent);
    const has = normalizeText(el.textContent);
    if (had.length <= has.length + 1) continue;
    // The same passage, with words missing — not some other element.
    const hadWords = new Set(had.split(" "));
    const hasWords = has.split(" ").filter(Boolean);
    if (hasWords.filter((word) => hadWords.has(word)).length < hasWords.length * 0.9) continue;
    el.replaceChildren(...copy.childNodes);
    repaired += 1;
  }
  return repaired;
}

// Puts a copy of `block` (from the original page) into the article at the
// matching spot: among the children of the nearest element of the article
// it was inside of, before the first one that came after it.
function insertRestored(block: Element, out: Document, outById: Map<string, Element>, byId: Map<string, Element>, content: HTMLElement) {
  const copy = out.importNode(block, true) as Element;
  const originalOf = (el: Element) => byId.get(idOf(el) ?? "");
  let ancestor = block.parentElement;
  while (ancestor && ancestor.localName !== "body" && !outById.has(idOf(ancestor) ?? "")) ancestor = ancestor.parentElement;
  const container = ancestor && ancestor.localName !== "body" ? outById.get(idOf(ancestor)!)! : null;

  if (container) {
    for (const child of container.children) {
      const original = originalOf(child);
      if (original && precedes(block, original) && !block.contains(original)) {
        container.insertBefore(copy, child);
        outById.set(idOf(block)!, copy);
        return;
      }
    }
    container.appendChild(copy);
    outById.set(idOf(block)!, copy);
    return;
  }

  // No kept ancestor: before the first kept element that follows it, at a
  // level where a block may go.
  let next: Element | null = null;
  for (const [id, el] of outById) {
    const original = byId.get(id);
    if (!original || !precedes(block, original) || block.contains(original) || !content.contains(el)) continue;
    if (!next || precedes(byId.get(idOf(el)!)!, byId.get(idOf(next)!)!)) next = el;
  }
  if (next) {
    let target: Element = next;
    while (target.parentElement && target.parentElement !== content && (INLINE_PARENTS.has(target.localName) || /^(p|h[1-6])$/.test(target.parentElement.localName) || INLINE_PARENTS.has(target.parentElement.localName))) {
      target = target.parentElement;
    }
    target.parentElement?.insertBefore(copy, target);
  } else {
    const page = content.querySelector("#readability-page-1") ?? content;
    page.appendChild(copy);
  }
  outById.set(idOf(block)!, copy);
}

// The large picture between the title and the article (a post's cover),
// which Readability leaves out when the article's element starts after it.
function addLeadImage(source: Document, content: HTMLElement, meta: PageMetadata) {
  if (!meta.titleId) return;
  const title = source.querySelector(`[${ID_ATTR}="${meta.titleId}"]`);
  const firstKept = (() => {
    for (const el of content.querySelectorAll(`[${ID_ATTR}]`)) {
      const original = source.querySelector(`[${ID_ATTR}="${idOf(el)}"]`);
      if (original && original.localName !== "body") return original;
    }
    return null;
  })();
  if (!title || !firstKept || !precedes(title, firstKept)) return;
  for (const img of source.querySelectorAll("img[src]")) {
    if (!precedes(title, img)) continue;
    if (!precedes(img, firstKept)) break;
    if (inJunk(img, true) || img.closest("a, button")) continue;
    const { width, height } = declaredSize(img);
    if (!(width >= 400) && !(Number.isNaN(width) && img.closest("figure, picture"))) continue;
    if (height < 100) continue;
    if (content.querySelector(`[${ID_ATTR}="${idOf(img)}"]`)) return; // already in
    const out = content.ownerDocument;
    const figure = out.createElement("figure");
    figure.append(out.importNode(img, true));
    const page = content.querySelector("#readability-page-1") ?? content;
    page.prepend(figure);
    return;
  }
}
