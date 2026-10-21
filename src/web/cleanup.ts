import { escapeCss, normalizeText } from "./html.ts";

// The last pass over the extracted article (extract.ts) before it's laid
// out: the site's classes and inline styles go (the book has its own
// stylesheet: book.ts), and so does what only made sense on the live page —
// buttons, form controls, icon glyphs, "#" permalinks beside headings,
// "(opens in a new tab)" notes for screen readers inside links, elements
// left empty.

const KEEP_ATTRS = new Set([
  "href", "src", "alt", "title", "colspan", "rowspan", "id", "name", "width", "height", "start", "reversed", "value",
  "type", "open", "lang", "dir", "datetime", "cite", "headers", "scope", "abbr", "span", "xml:lang",
]);

const MEDIA = "img, svg, figure, table, hr, pre, canvas, math, [data-kr-island], [data-kr-media], [data-kr-math]";
const SCREEN_READER_ONLY = /(^|\s)(sr-only|visually-?hidden|screen-reader(-text)?|a11y-hidden|assistive-text|hidden-visually)(\s|$)/i;

function svgSize(svg: Element): { width: number; height: number } {
  const width = parseFloat(svg.getAttribute("width") ?? "");
  const height = parseFloat(svg.getAttribute("height") ?? "");
  const box = (svg.getAttribute("viewBox") ?? "").split(/[\s,]+/).map(Number);
  return {
    width: Number.isFinite(width) ? width : Number.isFinite(box[2]) ? box[2] : NaN,
    height: Number.isFinite(height) ? height : Number.isFinite(box[3]) ? box[3] : NaN,
  };
}

// An icon: a small glyph, or any picture inside a control or a heading's
// permalink. (Sizes set only by the site's CSS are settled later, from the
// styled render: renderer.ts.)
export function isIconSvg(svg: Element): boolean {
  if (svg.closest("button, [role=button], summary")) return true;
  const link = svg.closest("a");
  if (link && !normalizeText(link.textContent).length && link.querySelectorAll("svg").length === 1) return false; // a linked picture
  if (link && normalizeText(link.textContent).length > 0) return true; // an icon beside link text
  const { width, height } = svgSize(svg);
  return width <= 32 && height <= 32;
}

function similar(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const y = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return x.length > 0 && x === y;
}

export function cleanArticle(content: HTMLElement, title: string): void {
  for (const el of [...content.querySelectorAll("script, style, noscript, template, link, meta, button, input, select, textarea, dialog, [role=dialog], nav, object, embed, iframe")]) {
    el.remove();
  }
  for (const form of [...content.querySelectorAll("form, label, fieldset")]) form.replaceWith(...[...form.childNodes]);
  for (const el of [...content.querySelectorAll("[hidden]")]) el.remove();

  // Notes for screen readers inside links and headings ("opens in a new
  // tab", "Link to this section") — elsewhere they may stand for an icon
  // that's gone (a ✓ in a table), so they stay.
  for (const el of [...content.querySelectorAll("a [class], h1 [class], h2 [class], h3 [class], h4 [class], h5 [class], h6 [class]")]) {
    if (SCREEN_READER_ONLY.test(el.getAttribute("class") ?? "")) el.remove();
  }

  // Permalinks beside headings: "#", "¶", "🔗", or an icon alone.
  for (const link of [...content.querySelectorAll("h1 a, h2 a, h3 a, h4 a, h5 a, h6 a")]) {
    const text = normalizeText(link.textContent);
    const href = link.getAttribute("href") ?? "";
    if ((!text || /^[#¶§🔗]$|^(link|permalink|anchor)$/iu.test(text)) && (href.startsWith("#") || !href)) link.remove();
    else if (href.startsWith("#") && normalizeText(link.closest("h1, h2, h3, h4, h5, h6")?.textContent) === text) {
      link.replaceWith(...[...link.childNodes]); // the heading's own text, linked to itself
    }
  }

  for (const svg of [...content.querySelectorAll("svg")]) {
    if (!svg.parentElement?.closest("svg") && isIconSvg(svg)) svg.remove();
  }

  // Pictures: only ones there's something to fetch for; no tracking pixels.
  for (const img of [...content.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    const width = parseFloat(img.getAttribute("width") ?? "");
    const height = parseFloat(img.getAttribute("height") ?? "");
    const pixel = (width <= 2 && height <= 2) || /(\/pixel|beacon|tracking|\/1x1|spacer\.gif|\/p\.gif)/i.test(src);
    if (!/^(https?:|data:image\/|kr-island:)/i.test(src) || pixel) img.remove();
  }

  // The title is shown in the header (book.ts); a copy at the article's top goes.
  const firstHeading = content.querySelector("h1, h2, h3");
  if (firstHeading && similar(normalizeText(firstHeading.textContent), title)) {
    const before = normalizeText(
      [...content.querySelectorAll("p, li, pre, table")].filter((el) => el.compareDocumentPosition(firstHeading) & 4).map((el) => el.textContent).join(" "),
    );
    if (before.length < 200) firstHeading.remove();
  }

  for (const details of content.querySelectorAll("details")) details.setAttribute("open", "");

  // Attributes: the site's classes and styles go, except inside SVG, where
  // they're the drawing.
  for (const el of [content, ...content.querySelectorAll("*")]) {
    if (el.closest("svg")) {
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      continue;
    }
    for (const attr of [...el.attributes]) {
      if (KEEP_ATTRS.has(attr.name) || attr.name.startsWith("data-kr-")) continue;
      el.removeAttribute(attr.name);
    }
    if (el.localName === "a" && /^javascript:/i.test(el.getAttribute("href") ?? "")) el.removeAttribute("href");
  }

  // Empty elements, innermost first.
  const candidates = [...content.querySelectorAll("p, div, span, section, article, aside, header, footer, li, a, strong, em, b, i, figure, figcaption, blockquote, ul, ol, dl, h1, h2, h3, h4, h5, h6")].reverse();
  for (const el of candidates) {
    if (normalizeText(el.textContent).length > 0 || el.querySelector(MEDIA)) continue;
    if (el.localName === "a" && el.getAttribute("name")) continue; // an anchor target
    if (el.getAttribute("id") && content.querySelector(`a[href="#${escapeCss(el.getAttribute("id")!)}"]`)) continue;
    el.remove();
  }
}
