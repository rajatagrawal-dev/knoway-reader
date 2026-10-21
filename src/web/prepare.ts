// The server's MathML → LaTeX converter (plain JS, no dependencies).
import { mathToTex } from "../../server/mathml.js";
import { escapeCss, isPlaceholderSrc, normalizeText, parseSrcset, pickSrcsetCandidate } from "./html.ts";
import type { ImportReport } from "./types.ts";

// Readies a fetched page for extraction (extract.ts) so that nothing on it
// is lost on the way: every element gets an id that survives the article
// extractor (so what it dropped can be found and put back), and everything
// the extractor or the book can't take as it is gets a form they can:
//  - pictures that load by script (lazy loading, srcset, <picture>,
//    <noscript> fallbacks) get a plain src;
//  - video, audio and embeds (YouTube, tweets, CodePens, Gists) become a
//    picture-and-link card, since a PDF can't play them;
//  - formulas become their TeX source;
//  - figures drawn with CSS (boxes and arrows in styled HTML, which mean
//    nothing without the site's stylesheet) become placeholders, captured
//    later as pictures from a styled render of the page (renderer.ts).

export const ID_ATTR = "data-kr-id";

export interface Island {
  id: string;
  kind: "css" | "canvas";
  alt: string; // what the page says it shows (aria-label), if anything
  text: string; // the words drawn in it
  element: Element; // the original, detached, for when it can't be captured
}

export interface PreparedPage {
  doc: Document;
  islands: Map<string, Island>;
}

// Numbers every element in the body, in document order.
export function tagElements(doc: Document): void {
  const body = doc.body;
  if (!body) return;
  let next = 0;
  body.setAttribute(ID_ATTR, String(next++));
  for (const el of body.querySelectorAll("*")) el.setAttribute(ID_ATTR, String(next++));
}

// ---- Addresses --------------------------------------------------------------------

function withoutHash(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

// Every address in the page made absolute (from `base`); links to a spot on
// the page itself (any of `pageUrls`) made into fragment links.
export function absolutize(doc: Document, base: string, pageUrls: string[]) {
  const resolve = (value: string | null): string | null => {
    if (value === null) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return new URL(trimmed, base).href;
    } catch {
      return null;
    }
  };
  const samePage = new Set(pageUrls.map(withoutHash));
  for (const a of doc.querySelectorAll("a[href], area[href]")) {
    const href = a.getAttribute("href")!.trim();
    if (href.startsWith("#")) continue;
    if (/^javascript:/i.test(href)) {
      a.removeAttribute("href");
      continue;
    }
    const url = resolve(href);
    if (!url) continue;
    // A link to a spot on this same page stays a link within the document.
    const hash = url.indexOf("#");
    if (hash >= 0 && samePage.has(url.slice(0, hash)) && url.length > hash + 1) a.setAttribute("href", url.slice(hash));
    else a.setAttribute("href", url);
  }
  for (const [selector, attr] of [
    ["img[src], source[src], video[src], audio[src], iframe[src], embed[src], track[src], input[src]", "src"],
    ["video[poster]", "poster"],
    ["object[data]", "data"],
    ["blockquote[cite], q[cite], ins[cite], del[cite]", "cite"],
  ] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(attr)!;
      if (/^data:/i.test(value.trim())) continue;
      const url = resolve(value);
      if (url) el.setAttribute(attr, url);
    }
  }
  for (const el of doc.querySelectorAll("img[srcset], source[srcset]")) {
    const candidates = parseSrcset(el.getAttribute("srcset")!);
    el.setAttribute(
      "srcset",
      candidates
        .map((c) => {
          const url = /^data:/i.test(c.url) ? c.url : resolve(c.url);
          if (!url) return null;
          return `${url}${c.width ? ` ${c.width}w` : c.density ? ` ${c.density}x` : ""}`;
        })
        .filter(Boolean)
        .join(", "),
    );
  }
  // Lazy-loading attributes hold addresses too.
  for (const el of doc.querySelectorAll("img, source, iframe, video")) {
    for (const attr of [...el.attributes]) {
      if (!/^data-(lazy-)?(src|original|url|hi-res-src|full-src|orig-file|large-file)$/i.test(attr.name)) continue;
      const url = resolve(attr.value);
      if (url) el.setAttribute(attr.name, url);
    }
    for (const attr of [...el.attributes]) {
      if (!/^data-(lazy-)?srcset$/i.test(attr.name)) continue;
      el.setAttribute(
        attr.name,
        parseSrcset(attr.value)
          .map((c) => `${resolve(c.url) ?? c.url}${c.width ? ` ${c.width}w` : c.density ? ` ${c.density}x` : ""}`)
          .join(", "),
      );
    }
  }
  for (const el of doc.querySelectorAll("svg image, svg use")) {
    for (const attr of ["href", "xlink:href"]) {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith("#")) continue;
      const url = resolve(value);
      if (url) el.setAttribute(attr, url);
    }
  }
}

// ---- Pictures ---------------------------------------------------------------------

const LAZY_SRC_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src", "data-full-src", "data-orig-file", "data-large-file"];
const LAZY_SRCSET_ATTRS = ["data-srcset", "data-lazy-srcset"];

// <noscript> holds what the page shows without its scripts — often the real
// <img> behind a lazy-loading placeholder.
function unwrapNoscript(doc: Document) {
  for (const noscript of [...doc.querySelectorAll("noscript")]) {
    const pictures = noscript.querySelectorAll("img, picture, video, iframe");
    if (pictures.length === 0) {
      noscript.remove(); // "Please enable JavaScript", tracking pixels' wrappers…
      continue;
    }
    const real = noscript.querySelector("img");
    const container = noscript.parentElement;
    const placeholder =
      noscript.previousElementSibling?.localName === "img"
        ? noscript.previousElementSibling
        : container && container.querySelectorAll(":scope > img, :scope > picture > img").length === 1
          ? container.querySelector(":scope > img, :scope > picture > img")
          : null;
    if (real && pictures.length === 1 && placeholder && placeholder !== real) {
      const src = placeholder.getAttribute("src");
      const lazy = LAZY_SRC_ATTRS.some((attr) => placeholder.hasAttribute(attr)) || placeholder.hasAttribute("data-srcset");
      if (isPlaceholderSrc(src) || lazy || placeholder.getAttribute("loading") === "lazy") {
        const picture = placeholder.parentElement?.localName === "picture" ? placeholder.parentElement : placeholder;
        picture.replaceWith(real);
        noscript.remove();
        continue;
      }
      // The placeholder was the real picture after all: the copy goes.
      noscript.remove();
      continue;
    }
    noscript.replaceWith(...[...noscript.childNodes]);
  }
}

// Every <img> (and <picture>) ends with one plain, absolute src: the best
// of what its srcset, <source>s and lazy-loading attributes offer.
export function settlePictures(doc: Document) {
  for (const img of [...doc.querySelectorAll("img")]) {
    let src = img.getAttribute("src");
    const lazySrc = LAZY_SRC_ATTRS.map((attr) => img.getAttribute(attr)).find((value) => value && !isPlaceholderSrc(value));
    if (lazySrc && isPlaceholderSrc(src)) src = lazySrc;

    const candidates = [];
    const picture = img.parentElement?.localName === "picture" ? img.parentElement : null;
    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        const type = source.getAttribute("type") ?? "";
        if (/jxl|jpeg-?xl|heic|heif/i.test(type)) continue; // formats browsers may not draw
        const media = source.getAttribute("media") ?? "";
        if (/print|max-width:\s*[1-5]\d\dpx|prefers-color-scheme:\s*dark/i.test(media)) continue;
        const srcset = source.getAttribute("srcset") ?? LAZY_SRCSET_ATTRS.map((attr) => source.getAttribute(attr)).find(Boolean) ?? "";
        candidates.push(...parseSrcset(srcset));
      }
    }
    const ownSrcset = img.getAttribute("srcset");
    const lazySrcset = LAZY_SRCSET_ATTRS.map((attr) => img.getAttribute(attr)).find(Boolean);
    candidates.push(...parseSrcset(ownSrcset && !isPlaceholderSrc(parseSrcset(ownSrcset)[0]?.url) ? ownSrcset : lazySrcset ?? ownSrcset ?? ""));
    const usable = candidates.filter((c) => !isPlaceholderSrc(c.url));
    const best = pickSrcsetCandidate(usable);
    if (best && (isPlaceholderSrc(src) || best.width || (best.density ?? 1) > 1)) src = best.url;

    if (src && !isPlaceholderSrc(src)) img.setAttribute("src", src);
    else if (src && /^data:image\//i.test(src) && src.length >= 400) img.setAttribute("src", src);
    else img.removeAttribute("src");
    for (const attr of ["srcset", "sizes", "loading", "decoding", "fetchpriority", ...LAZY_SRC_ATTRS, ...LAZY_SRCSET_ATTRS]) img.removeAttribute(attr);
    if (picture) picture.replaceWith(img);
  }
}

// ---- Media and embeds -------------------------------------------------------------

type MediaKind = ImportReport["media"][number]["kind"];

interface Embed {
  kind: MediaKind;
  label: string;
  url: string;
  thumbnail?: string;
}

const AD_HOSTS = /(doubleclick|googlesyndication|googletagmanager|google-analytics|adservice|amazon-adsystem|facebook\.com\/tr|scorecardresearch|quantserve|taboola|outbrain|chartbeat|hotjar|criteo|adnxs)/i;

// What an embedded frame shows, and where to watch or open it instead.
export function describeEmbed(src: string): Embed | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || AD_HOSTS.test(src)) return null;
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname;
  let match: RegExpMatchArray | null;
  if (/(^|\.)youtube(-nocookie)?\.com$/.test(host) && (match = path.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/))) {
    return {
      kind: "video",
      label: "YouTube video",
      url: `https://www.youtube.com/watch?v=${match[1]}`,
      thumbnail: `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg`,
    };
  }
  if (host === "player.vimeo.com" && (match = path.match(/^\/video\/(\d+)/))) {
    return { kind: "video", label: "Vimeo video", url: `https://vimeo.com/${match[1]}` };
  }
  if (/loom\.com$/.test(host) && (match = path.match(/^\/embed\/(\w+)/))) {
    return { kind: "video", label: "Loom video", url: `https://www.loom.com/share/${match[1]}` };
  }
  if (/(^|\.)(twitter|x)\.com$/.test(host)) {
    const id = url.searchParams.get("id");
    return { kind: "embed", label: "Post on X", url: id ? `https://x.com/i/status/${id}` : src };
  }
  if (host === "open.spotify.com") return { kind: "audio", label: "Spotify", url: `https://open.spotify.com${path.replace(/^\/embed/, "")}` };
  if (host === "w.soundcloud.com") {
    const target = url.searchParams.get("url");
    return { kind: "audio", label: "SoundCloud", url: target ?? src };
  }
  if (/podcasts\.apple\.com$|embed\.podcasts\.apple\.com$/.test(host)) return { kind: "audio", label: "Podcast", url: src.replace("embed.podcasts", "podcasts") };
  if (host === "codepen.io") return { kind: "embed", label: "CodePen", url: src.replace("/embed/", "/pen/") };
  if (/codesandbox\.io$/.test(host)) return { kind: "embed", label: "CodeSandbox", url: src.replace("/embed/", "/s/") };
  if (/stackblitz\.com$/.test(host)) return { kind: "embed", label: "StackBlitz", url: src };
  if (/jsfiddle\.net$/.test(host)) return { kind: "embed", label: "JSFiddle", url: src.replace(/\/embedded\/.*$/, "/") };
  if (/observablehq\.com$/.test(host)) return { kind: "embed", label: "Observable notebook", url: src };
  if (/google\.[a-z.]+$/.test(host) && path.startsWith("/maps")) return { kind: "embed", label: "Map", url: src };
  if (host === "docs.google.com") return { kind: "embed", label: "Google document", url: src.replace(/\/(embed|pubhtml|preview)(\?.*)?$/, "") };
  if (/(^|\.)github\.com$/.test(host) || host === "gist.github.com") return { kind: "code", label: "Code on GitHub", url: src };
  return { kind: "embed", label: `Embedded content from ${host}`, url: src };
}

function mediaCard(doc: Document, embed: Embed, title: string | null, from: Element): HTMLElement {
  const card = doc.createElement("figure");
  card.setAttribute("data-kr-media", embed.kind);
  card.setAttribute("data-kr-media-url", embed.url);
  if (title) card.setAttribute("data-kr-media-title", title);
  const id = from.getAttribute(ID_ATTR);
  if (id) card.setAttribute(ID_ATTR, id);
  if (embed.thumbnail) {
    const img = doc.createElement("img");
    img.setAttribute("src", embed.thumbnail);
    img.setAttribute("alt", "");
    card.append(img);
  }
  const caption = doc.createElement("figcaption");
  caption.append(`${embed.kind === "video" ? "▶ " : embed.kind === "audio" ? "♪ " : ""}${embed.label}${title ? ` — ${title}` : ""}: `);
  const link = doc.createElement("a");
  link.setAttribute("href", embed.url);
  link.textContent = embed.url.replace(/^https?:\/\/(www\.)?/, "");
  caption.append(link);
  card.append(caption);
  return card;
}

function fileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

function convertMedia(doc: Document, pageUrl: string) {
  const titleOf = (el: Element) =>
    normalizeText(el.getAttribute("title") ?? el.getAttribute("aria-label") ?? el.getAttribute("data-title")) || null;
  const replace = (el: Element, embed: Embed, title: string | null) => el.replaceWith(mediaCard(doc, embed, title, el));

  for (const video of [...doc.querySelectorAll("video")]) {
    const src = [video.getAttribute("src"), ...[...video.querySelectorAll("source")].map((s) => s.getAttribute("src"))].find(
      (value) => value && /^https?:/i.test(value),
    );
    const poster = video.getAttribute("poster");
    replace(
      video,
      {
        kind: "video",
        label: "Video",
        url: src ?? pageUrl,
        ...(poster && /^https?:/i.test(poster) ? { thumbnail: poster } : {}),
      },
      titleOf(video) ?? (src ? fileName(src) : null),
    );
  }
  for (const audio of [...doc.querySelectorAll("audio")]) {
    const src = [audio.getAttribute("src"), ...[...audio.querySelectorAll("source")].map((s) => s.getAttribute("src"))].find(
      (value) => value && /^https?:/i.test(value),
    );
    replace(audio, { kind: "audio", label: "Audio", url: src ?? pageUrl }, titleOf(audio) ?? (src ? fileName(src) : null));
  }
  for (const frame of [...doc.querySelectorAll("iframe, embed, object")]) {
    const src = frame.getAttribute("src") ?? frame.getAttribute("data-src") ?? frame.getAttribute("data") ?? "";
    const width = parseFloat(frame.getAttribute("width") ?? "");
    const height = parseFloat(frame.getAttribute("height") ?? "");
    const hidden = (Number.isFinite(width) && width <= 2) || (Number.isFinite(height) && height <= 2) || /display:\s*none/i.test(frame.getAttribute("style") ?? "");
    const embed = !hidden && src ? describeEmbed(src) : null;
    if (!embed) {
      frame.remove();
      continue;
    }
    replace(frame, embed, titleOf(frame));
  }
  // Gists embed by script, which never runs here.
  for (const script of [...doc.querySelectorAll('script[src*="gist.github.com"]')]) {
    const src = script.getAttribute("src")!.replace(/\.js(\?.*)?$/, "");
    replace(script, { kind: "code", label: "GitHub Gist", url: src }, null);
  }
}

// ---- Math -------------------------------------------------------------------------

// The formula's TeX in a span, which the article extractor leaves as it
// is (a <div> of bare text it would rewrite as a <p>, losing the marking).
function mathElement(doc: Document, tex: string, display: boolean, from: Element): HTMLElement {
  const el = doc.createElement("span");
  el.setAttribute("data-kr-math", display ? "display" : "inline");
  const id = from.getAttribute(ID_ATTR);
  if (id) el.setAttribute(ID_ATTR, id);
  el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
  if (!display) return el;
  const block = doc.createElement("div");
  block.append(el);
  return block;
}

function texFromMath(math: Element): string {
  const alt = math.getAttribute("alttext");
  if (alt) return alt.trim().replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1").trim();
  const annotation = [...math.querySelectorAll("annotation")].find((a) => /tex/i.test(a.getAttribute("encoding") ?? ""));
  if (annotation) return normalizeText(annotation.textContent);
  try {
    return mathToTex(math.outerHTML) || normalizeText(math.textContent);
  } catch {
    return normalizeText(math.textContent);
  }
}

// Formulas, whatever drew them (KaTeX, MathJax 2 or 3, MathML, Wikipedia's
// math), as their TeX source — the one form the book can show faithfully.
function convertMath(doc: Document) {
  const swap = (el: Element, tex: string, display: boolean) => {
    if (!tex) return;
    el.replaceWith(mathElement(doc, tex, display, el));
  };
  for (const el of [...doc.querySelectorAll(".katex-display, .katex")]) {
    if (!el.isConnected) continue;
    const annotation = [...el.querySelectorAll("annotation")].find((a) => /tex/i.test(a.getAttribute("encoding") ?? ""));
    const math = el.querySelector("math");
    const tex = annotation ? normalizeText(annotation.textContent) : math ? texFromMath(math) : "";
    swap(el, tex, el.classList.contains("katex-display") || el.closest(".katex-display") !== null);
  }
  const scripts = [...doc.querySelectorAll('script[type^="math/tex"], script[type^="math/asciimath"]')];
  if (scripts.length > 0) {
    for (const rendered of doc.querySelectorAll(".MathJax_Preview, .MathJax, .MathJax_Display, .MathJax_SVG, .MathJax_SVG_Display, .MathJax_CHTML, .MJX_Assistive_MathML")) {
      rendered.remove();
    }
    for (const script of scripts) swap(script, normalizeText(script.textContent), /mode\s*=\s*display/i.test(script.getAttribute("type") ?? ""));
  }
  for (const container of [...doc.querySelectorAll("mjx-container")]) {
    const math = container.querySelector("math");
    swap(container, math ? texFromMath(math) : "", container.getAttribute("display") === "true" || container.getAttribute("display") === "block");
  }
  for (const wiki of [...doc.querySelectorAll(".mwe-math-element")]) {
    const math = wiki.querySelector("math");
    const fallback = wiki.querySelector("img[alt]");
    const tex = math ? texFromMath(math) : normalizeText(fallback?.getAttribute("alt"));
    swap(wiki, tex.replace(/^\{\\displaystyle\s*([\s\S]*)\}$/, "$1"), wiki.querySelector(".mwe-math-fallback-image-display, math[display=block]") !== null);
  }
  for (const math of [...doc.querySelectorAll("math")]) {
    if (!math.isConnected) continue;
    swap(math, texFromMath(math), math.getAttribute("display") === "block");
  }
}

// ---- Figures drawn with CSS ---------------------------------------------------------

const MEDIA_LIKE = "img, picture, svg, video, audio, iframe, canvas, object, embed, table, pre, math, blockquote, [data-kr-media], [data-kr-math]";

function ownTextLength(el: Element): number {
  let length = 0;
  for (const node of el.childNodes) if (node.nodeType === 3) length += normalizeText(node.textContent).length;
  return length;
}

function hasOwnText(el: Element): boolean {
  return ownTextLength(el) > 0;
}

function islandPlaceholder(doc: Document, island: Island, caption: Element | null): HTMLElement {
  const figure = doc.createElement("figure");
  figure.setAttribute(ID_ATTR, island.id);
  figure.setAttribute("data-kr-island", island.id);
  const img = doc.createElement("img");
  img.setAttribute("src", `kr-island:${island.id}`);
  img.setAttribute("alt", island.alt);
  figure.append(img);
  if (caption) figure.append(caption);
  return figure;
}

function findIslands(doc: Document): Map<string, Island> {
  const islands = new Map<string, Island>();
  const inIsland = (el: Element) => [...islands.values()].some((island) => island.element.contains(el));
  // Each piece of text on its own: a diagram's labels sit in separate boxes,
  // and run together they'd read (and search) as one word.
  const textOf = (el: Element) => {
    const pieces: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === 3) pieces.push(node.textContent ?? "");
      else if ((node as Element).localName !== "figcaption") node.childNodes.forEach(walk);
    };
    walk(el);
    return normalizeText(pieces.join(" "));
  };
  const label = (el: Element) => {
    const own = el.getAttribute("aria-label");
    if (own) return normalizeText(own);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (normalizeText(text)) return normalizeText(text);
    }
    const inner = el.querySelector("[role=img][aria-label]");
    return normalizeText(inner?.getAttribute("aria-label") ?? el.getAttribute("title") ?? "");
  };
  const add = (el: Element, kind: Island["kind"]) => {
    const id = el.getAttribute(ID_ATTR);
    if (!id || inIsland(el)) return;
    const island: Island = { id, kind, alt: label(el), text: kind === "canvas" ? normalizeText(el.textContent) : textOf(el), element: el };
    const caption = el.localName === "figure" ? el.querySelector(":scope > figcaption") : null;
    el.replaceWith(islandPlaceholder(doc, island, caption ? (caption.cloneNode(true) as Element) : null));
    islands.set(id, island);
  };

  // Words placed by the page's CSS: elements with text of their own that
  // aren't part of a picture, table, code listing, formula or quote (and
  // aren't the caption). A diagram's labels are many and short.
  const labels = (root: Element) =>
    [root, ...root.querySelectorAll("*")].filter((el) => {
      if (!hasOwnText(el) || el.closest("figcaption")) return false;
      const media = el.closest(MEDIA_LIKE);
      return !media || !root.contains(media);
    });

  // A figure whose content is boxes of text laid out by CSS — perhaps with
  // SVG connectors or pictures among them.
  for (const figure of [...doc.querySelectorAll("figure")]) {
    if (!figure.isConnected || figure.closest("nav, header, footer, [data-kr-media]")) continue;
    const parts = [...figure.children].filter((child) => child.localName !== "figcaption");
    if (parts.length === 0) continue;
    const words = parts.flatMap(labels);
    if (words.length < 3) continue; // a picture with a caption, a pull quote
    const average = words.reduce((sum, el) => sum + ownTextLength(el), 0) / words.length;
    if (average > 120) continue; // paragraphs, not labels
    add(figure, "css");
  }
  // Anything the page marks as one picture that isn't simply a picture.
  for (const el of [...doc.querySelectorAll("[role=img]")]) {
    if (!el.isConnected || /^(img|svg|picture|canvas|video|audio|iframe|object|embed|figure)$/.test(el.localName)) continue;
    const hasWords = labels(el).length > 0;
    const background = /background/i.test(el.getAttribute("style") ?? "");
    if (!hasWords && !(el.children.length > 1 && el.querySelector("svg, img")) && !(el.children.length === 0 && background)) continue;
    add(el, "css");
  }
  for (const canvas of [...doc.querySelectorAll("canvas")]) {
    if (!canvas.isConnected) continue;
    const width = parseFloat(canvas.getAttribute("width") ?? "300");
    const height = parseFloat(canvas.getAttribute("height") ?? "150");
    if (width < 40 || height < 40) continue;
    add(canvas, "canvas");
  }
  return islands;
}

// ---- Hidden until a script shows it ---------------------------------------------------

// Content a script would have shown: sections that fade in on scroll start
// out with an inline visibility:hidden or opacity:0 (truly hidden things
// use display:none or the hidden attribute), and tab panels other than the
// first start out hidden. The article extractor would drop them as hidden.
export function revealScripted(doc: Document) {
  for (const el of doc.querySelectorAll("[style]")) {
    const style = el.getAttribute("style")!;
    const revealed = style
      .replace(/(^|;)\s*visibility\s*:\s*hidden\s*(!important)?\s*(?=;|$)/gi, "$1")
      .replace(/(^|;)\s*opacity\s*:\s*0(\.0+)?\s*(!important)?\s*(?=;|$)/gi, "$1");
    if (revealed !== style) el.setAttribute("style", revealed);
  }
  for (const panel of doc.querySelectorAll("[role=tabpanel]")) {
    const hidden = panel.hasAttribute("hidden") || /display\s*:\s*none/i.test(panel.getAttribute("style") ?? "");
    if (!hidden) continue;
    panel.removeAttribute("hidden");
    panel.setAttribute("style", (panel.getAttribute("style") ?? "").replace(/display\s*:\s*none\s*(!important)?;?/gi, ""));
    panel.removeAttribute("aria-hidden");
  }
  // Each panel under its tab's name, since the tabs themselves (buttons) go.
  for (const panel of doc.querySelectorAll("[role=tabpanel]")) {
    const tabId = panel.getAttribute("aria-labelledby")?.split(/\s+/)[0];
    const tab = (tabId ? doc.getElementById(tabId) : null) ?? (panel.id ? doc.querySelector(`[role=tab][aria-controls="${escapeCss(panel.id)}"]`) : null);
    const name = normalizeText(tab?.textContent);
    if (!name || name.length > 60) continue;
    const label = doc.createElement("p");
    const strong = doc.createElement("strong");
    strong.textContent = name;
    label.append(strong);
    panel.prepend(label);
  }
}

// ---- Notes and sidebars ------------------------------------------------------------

// Boxes in the text — notes, tips, warnings, "see also", sidebars — marked
// so the book can set them as boxes (its stylesheet knows nothing of the
// site's class names, which go).
const CALLOUT_CLASS = /(^|[\s_-])(admonition|callout|note|notice|tip|hint|warning|caution|important|danger|info-?box|sidebar|alert|seealso)([\s_-]|$)/i;

function markCallouts(doc: Document) {
  for (const el of doc.querySelectorAll("div, section, aside, blockquote")) {
    if (!CALLOUT_CLASS.test(el.getAttribute("class") ?? "") || el.closest("nav, header, footer")) continue;
    const text = normalizeText(el.textContent).length;
    if (text < 20 || text > 4000 || el.querySelector("[data-kr-callout]")) continue;
    el.setAttribute("data-kr-callout", "");
  }
}

// ---- All together -----------------------------------------------------------------

export function preparePage(doc: Document, pageUrl: string, canonicalUrl?: string): PreparedPage {
  const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
  let base = pageUrl;
  try {
    if (baseHref) base = new URL(baseHref, pageUrl).href;
  } catch {
    base = pageUrl;
  }
  // The article extractor resolves what's left relative to the document's
  // base — which, for a parsed string, would be the app's own address.
  doc.querySelectorAll("base").forEach((el) => el.remove());
  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", base);
  doc.head?.prepend(baseEl);

  absolutize(doc, base, [pageUrl, ...(canonicalUrl ? [canonicalUrl] : [])]);
  revealScripted(doc);
  unwrapNoscript(doc);
  settlePictures(doc);
  convertMedia(doc, pageUrl);
  convertMath(doc);
  const islands = findIslands(doc);
  markCallouts(doc);
  doc.body?.querySelectorAll("script, style, template, link, meta").forEach((el) => el.remove());
  for (const details of doc.querySelectorAll("details")) details.setAttribute("open", "");
  return { doc, islands };
}
