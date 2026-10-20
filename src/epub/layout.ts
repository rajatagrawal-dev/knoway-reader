import { parseContentDocument, type EpubBook } from "./book.ts";
import { anchorKey, cssImports, findEntry, mimeTypeOf, resolveHref, sanitizeCss } from "./paths.ts";
import type { Face, FilledBox, FontName, HeadingMark, ImageBox, LaidOutChapter, LinkBox, Rgb, TextRun } from "./types.ts";

// Lays an EPUB's chapters out with the browser's own engine — the book's
// stylesheets and all — in an offscreen frame one page's text column wide,
// then reads back where every line of text, picture, rule and link ended up.
// The frame sets the book in the very fonts the PDF embeds, with kerning,
// ligatures, justification and hyphenation off, so each line drawn into the
// PDF (writePdf.ts) is exactly as long as the browser made it.

const FAMILY = { serif: "KR Serif", mono: "KR Mono", fallback: "KR Fallback" };
const NBSP = String.fromCharCode(0xa0);

const FACES: { name: FontName; family: string; weight: string; style: string }[] = [
  { name: "serif", family: FAMILY.serif, weight: "400", style: "normal" },
  { name: "serif-bold", family: FAMILY.serif, weight: "700", style: "normal" },
  { name: "serif-italic", family: FAMILY.serif, weight: "400", style: "italic" },
  { name: "serif-bold-italic", family: FAMILY.serif, weight: "700", style: "italic" },
  { name: "mono", family: FAMILY.mono, weight: "400", style: "normal" },
  { name: "mono-bold", family: FAMILY.mono, weight: "700", style: "normal" },
  { name: "fallback", family: FAMILY.fallback, weight: "400", style: "normal" },
];

// What the book's own CSS isn't allowed to change: anything that would make
// the browser place glyphs differently from how the PDF draws them.
function overrideCss(column: { width: number; height: number }): string {
  return `
html, body {
  margin: 0 !important; padding: 0 !important; width: auto !important; min-width: 0 !important;
  max-width: none !important; height: auto !important; min-height: 0 !important;
  columns: auto !important; column-count: auto !important; background: transparent !important;
  -webkit-text-size-adjust: none; text-size-adjust: none;
}
html { overflow: hidden !important; }
*, *::before, *::after {
  font-variant: normal !important; font-variant-ligatures: none !important; font-kerning: none !important;
  font-feature-settings: normal !important; font-synthesis: none !important; letter-spacing: normal !important;
  word-spacing: normal !important; hyphens: none !important; -webkit-hyphens: none !important;
  text-rendering: optimizeSpeed !important; text-shadow: none !important; tab-size: 4 !important;
  overflow-wrap: break-word; animation: none !important; transition: none !important;
}
img, svg, video, object { max-width: 100% !important; max-height: ${Math.floor(column.height)}px !important; }
`;
}

const HEADING = "h1, h2, h3, h4, h5, h6";

function isMonospace(family: string, el: Element): boolean {
  return (
    /mono|courier|consol|menlo|monaco|typewriter|code|fixed/i.test(family) ||
    el.closest("pre, code, kbd, samp, tt") !== null
  );
}

function parseColor(value: string): { rgb: Rgb; alpha: number } | null {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!match) return null;
  const alphaRaw = match[4];
  const alpha = alphaRaw === undefined ? 1 : alphaRaw.endsWith("%") ? parseFloat(alphaRaw) / 100 : parseFloat(alphaRaw);
  return { rgb: [+match[1] / 255, +match[2] / 255, +match[3] / 255], alpha };
}

// A translucent colour as it looks over the white page.
function onWhite(color: { rgb: Rgb; alpha: number }): Rgb {
  return color.rgb.map((c) => 1 - color.alpha * (1 - c)) as Rgb;
}

function isNearWhite([r, g, b]: Rgb): boolean {
  return r > 0.97 && g > 0.97 && b > 0.97;
}

// ---- List markers --------------------------------------------------------

function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [value, numeral] of table) {
    while (n >= value) {
      out += numeral;
      n -= value;
    }
  }
  return out;
}

function toAlpha(n: number, letters: string): string {
  let out = "";
  while (n > 0) {
    n -= 1;
    out = letters[n % letters.length] + out;
    n = Math.floor(n / letters.length);
  }
  return out;
}

// The text of a list item's marker, which the browser draws as a
// ::marker the page can't read back — so it's put in as real text instead.
export function markerText(type: string, ordinal: number): string | null {
  switch (type) {
    case "none":
      return null;
    case "disc":
      return "•";
    case "circle":
      return "◦";
    case "square":
      return "▪";
    case "decimal-leading-zero":
      return `${String(ordinal).padStart(2, "0")}.`;
    case "lower-alpha":
    case "lower-latin":
      return `${toAlpha(ordinal, "abcdefghijklmnopqrstuvwxyz")}.`;
    case "upper-alpha":
    case "upper-latin":
      return `${toAlpha(ordinal, "abcdefghijklmnopqrstuvwxyz").toUpperCase()}.`;
    case "lower-roman":
      return `${toRoman(ordinal)}.`;
    case "upper-roman":
      return `${toRoman(ordinal).toUpperCase()}.`;
    case "lower-greek":
      return `${toAlpha(ordinal, "αβγδεζηθικλμνξοπρστυφχψω")}.`;
    default: {
      const quoted = type.match(/^["'](.*)["']$/);
      return quoted ? quoted[1] : `${ordinal}.`;
    }
  }
}

function insertListMarkers(doc: Document, win: Window) {
  for (const list of doc.body.querySelectorAll("ol, ul, menu")) {
    const items = [...list.children].filter((child) => child.localName === "li");
    const reversed = list.localName === "ol" && list.hasAttribute("reversed");
    const startAttr = parseInt(list.getAttribute("start") ?? "", 10);
    let ordinal = Number.isFinite(startAttr) ? startAttr : reversed ? items.length : 1;
    for (const li of items) {
      const value = parseInt(li.getAttribute("value") ?? "", 10);
      if (Number.isFinite(value)) ordinal = value;
      const style = win.getComputedStyle(li);
      const marker = style.display === "list-item" ? markerText(style.listStyleType, ordinal) : null;
      ordinal += reversed ? -1 : 1;
      if (!marker) continue;
      (li as HTMLElement).style.setProperty("list-style-type", "none", "important");
      // Into the block the item's first line belongs to.
      let target: Element = li;
      for (;;) {
        const first = target.firstElementChild;
        if (!first || /^(ol|ul|menu|table)$/.test(first.localName)) break;
        const nodes = [...target.childNodes];
        if (nodes.slice(0, nodes.indexOf(first)).some((node) => node.textContent?.trim())) break;
        if (win.getComputedStyle(first).display.startsWith("inline")) break;
        target = first;
      }
      const span = doc.createElement("span");
      span.setAttribute("data-kr-marker", "");
      if (style.listStylePosition === "inside") {
        span.textContent = marker + NBSP;
      } else {
        span.textContent = marker;
        span.style.cssText =
          "position:absolute;transform:translateX(-100%);padding-right:0.45em;text-indent:0;white-space:nowrap;text-transform:none;";
      }
      target.insertBefore(span, target.firstChild);
    }
  }
}

// ---- The frame -----------------------------------------------------------

export interface LayoutSession {
  layoutChapter(path: string): Promise<LaidOutChapter>;
  dispose(): void;
}

function textOf(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder().decode(bytes) : "";
}

export async function createLayout(
  book: EpubBook,
  fonts: Record<FontName, Uint8Array>,
  column: { width: number; height: number },
): Promise<LayoutSession> {
  const frame = document.createElement("iframe");
  // Same origin so it can be read; no scripts, so a book's can't run.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${column.width}px;height:${column.height}px;border:0;opacity:0;pointer-events:none;`;
  const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
  frame.srcdoc = "<!doctype html><html><head></head><body></body></html>";
  document.body.appendChild(frame);
  await loaded;
  const doc = frame.contentDocument!;
  const win = frame.contentWindow! as Window & typeof globalThis;

  for (const face of FACES) {
    const Ctor = win.FontFace ?? FontFace;
    const fontFace = new Ctor(face.family, fonts[face.name].slice().buffer, { weight: face.weight, style: face.style });
    await fontFace.load();
    doc.fonts.add(fontFace);
  }

  const blobUrls = new Map<string, string>();
  const blobUrl = (path: string): string | null => {
    const entry = findEntry(book.files, path);
    if (!entry) return null;
    let url = blobUrls.get(entry);
    if (!url) {
      const bytes = book.files.get(entry)!;
      url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeTypeOf(entry, bytes) }));
      blobUrls.set(entry, url);
    }
    return url;
  };

  const stylesheet = (path: string, depth = 0): string => {
    const entry = findEntry(book.files, path);
    if (!entry || depth > 4) return "";
    const css = textOf(book.files.get(entry));
    const imported = cssImports(css)
      .map((href) => resolveHref(entry, href))
      .map((target) => (target ? stylesheet(target.path, depth + 1) : ""));
    return [...imported, sanitizeCss(css)].join("\n");
  };

  const dataUrl = (path: string): string | null => {
    const entry = findEntry(book.files, path);
    if (!entry) return null;
    const bytes = book.files.get(entry)!;
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${mimeTypeOf(entry, bytes)};base64,${btoa(binary)}`;
  };

  const layoutChapter = async (path: string): Promise<LaidOutChapter> => {
    const source = parseContentDocument(textOf(book.files.get(path)));

    // ---- Load the chapter into the frame ----
    doc.head.replaceChildren();
    for (const el of source.querySelectorAll("link, style")) {
      if (el.closest("body") && el.localName === "link") continue;
      let css = "";
      if (el.localName === "link") {
        if (!/\bstylesheet\b/i.test(el.getAttribute("rel") ?? "") || /\balternate\b/i.test(el.getAttribute("rel") ?? "")) continue;
        const target = resolveHref(path, el.getAttribute("href") ?? "");
        if (target) css = stylesheet(target.path);
      } else if (!el.closest("body")) {
        css = sanitizeCss(el.textContent ?? "");
      } else {
        continue;
      }
      const style = doc.createElement("style");
      style.textContent = css;
      doc.head.appendChild(style);
    }
    const override = doc.createElement("style");
    override.textContent = overrideCss(column);
    doc.head.appendChild(override);

    const html = doc.documentElement;
    for (const attr of [...html.attributes]) html.removeAttribute(attr.name);
    for (const attr of [...source.documentElement.attributes]) {
      if (/^(lang|xml:lang|dir|class|id|style)$/.test(attr.name)) html.setAttribute(attr.name, attr.value);
    }
    const sourceBody = source.body ?? source.documentElement;
    const body = doc.createElement("body");
    for (const attr of [...sourceBody.attributes]) {
      if (/^(lang|xml:lang|dir|class|id|style)$/.test(attr.name)) body.setAttribute(attr.name, attr.value);
    }
    for (const node of [...sourceBody.childNodes]) body.appendChild(doc.importNode(node, true));
    html.replaceChild(body, doc.body);

    body
      .querySelectorAll("script, noscript, iframe, object, embed, audio, video, template, link, style")
      .forEach((el) => {
        if (el.localName === "style") (el as HTMLStyleElement).textContent = sanitizeCss(el.textContent ?? "");
        else el.remove();
      });

    // Pictures load from the book itself.
    for (const img of body.querySelectorAll("img")) {
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      const target = resolveHref(path, img.getAttribute("src") ?? "");
      const entry = target ? findEntry(book.files, target.path) : null;
      const url = entry ? blobUrl(entry) : null;
      if (entry && url) {
        img.setAttribute("data-kr-src", entry);
        img.setAttribute("src", url);
      } else {
        img.remove();
      }
    }
    for (const image of body.querySelectorAll("image")) {
      const href = image.getAttribute("href") ?? image.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
      const target = resolveHref(path, href);
      const entry = target ? findEntry(book.files, target.path) : null;
      if (entry) image.setAttribute("data-kr-src", entry);
    }

    // ---- Set it in the reader's fonts ----
    const elements = [body, ...body.querySelectorAll<HTMLElement>("*")].filter(
      (el) => !el.closest("svg") || el.localName === "svg",
    ) as HTMLElement[];
    const original = elements.map((el) => {
      const style = win.getComputedStyle(el);
      return { family: style.fontFamily, justify: style.textAlign === "justify" };
    });
    elements.forEach((el, i) => {
      if (!el.style) return;
      const family = isMonospace(original[i].family, el) ? FAMILY.mono : FAMILY.serif;
      el.style.setProperty("font-family", `"${family}", "${FAMILY.fallback}"`, "important");
      if (original[i].justify) el.style.setProperty("text-align", "left", "important");
    });
    insertListMarkers(doc, win);

    await doc.fonts.ready;
    await Promise.all(
      [...body.querySelectorAll("img")].map((img) =>
        img.complete
          ? null
          : Promise.race([img.decode().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]),
      ),
    );

    // ---- Read back the layout ----
    const styles = new Map<Element, CSSStyleDeclaration>();
    const styleOf = (el: Element) => {
      let style = styles.get(el);
      if (!style) styles.set(el, (style = win.getComputedStyle(el)));
      return style;
    };

    const texts: (Omit<TextRun, "baseline"> & { weight: string; italic: boolean })[] = [];
    const range = doc.createRange();
    const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const parent = node.parentElement;
      if (!parent || parent.closest("svg, title, script, style")) continue;
      const style = styleOf(parent);
      if (style.visibility !== "visible") continue;
      const size = parseFloat(style.fontSize);
      if (!(size > 0)) continue;
      const mono = style.fontFamily.includes(FAMILY.mono);
      const bold = parseInt(style.fontWeight, 10) > 500;
      const italic = style.fontStyle !== "normal";
      const face: Face = mono ? (bold ? "mono-bold" : "mono") : `serif${bold ? "-bold" : ""}${italic ? "-italic" : ""}` as Face;
      const color = parseColor(style.color);
      if (color && color.alpha < 0.05) continue;
      const preserve = /^(pre|pre-wrap|break-spaces)$/.test(style.whiteSpace);
      const transform = style.textTransform;
      const keepWithNext = parent.closest(HEADING) !== null;

      const data = node.data;
      // Each word (in preformatted text, each stretch between tabs and line
      // ends) and where it landed; a word the browser broke across lines is
      // taken a character at a time.
      const pieces: { start: number; end: number; rect: DOMRect }[] = [];
      const pattern = preserve ? /[^\t\n\r\f]+/g : /[^ \t\n\r\f]+/g;
      for (const match of data.matchAll(pattern)) {
        const start = match.index;
        const end = start + match[0].length;
        range.setStart(node, start);
        range.setEnd(node, end);
        const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0);
        if (rects.length === 0) continue;
        if (rects.length === 1) {
          pieces.push({ start, end, rect: rects[0] });
          continue;
        }
        for (let i = start; i < end; ) {
          const step = data.codePointAt(i)! > 0xffff ? 2 : 1;
          range.setStart(node, i);
          range.setEnd(node, i + step);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) pieces.push({ start: i, end: i + step, rect });
          i += step;
        }
      }

      // Words side by side on one line become one run.
      let run: { start: number; end: number; left: number; right: number; top: number; bottom: number } | null = null;
      const flush = () => {
        if (!run) return;
        let text = data.slice(run.start, run.end);
        if (!preserve) text = text.replace(/[ \t\n\r\f]+/g, " ");
        if (transform === "uppercase") text = text.toUpperCase();
        else if (transform === "lowercase") text = text.toLowerCase();
        else if (transform === "capitalize") text = text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toUpperCase());
        if (run.right > -5 && run.left < column.width * 3 && run.bottom > -5) {
          texts.push({
            text,
            left: run.left,
            top: run.top,
            bottom: run.bottom,
            font: face,
            size,
            color: color ? onWhite(color) : [0, 0, 0],
            keepWithNext,
            weight: style.fontWeight,
            italic,
          });
        }
        run = null;
      };
      for (const piece of pieces) {
        const { rect } = piece;
        const sameLine =
          run &&
          Math.abs(rect.top - run.top) < 1 &&
          rect.left >= run.right - 1 &&
          (preserve || rect.left - run.right < size * 0.6);
        if (run && sameLine) {
          run.end = piece.end;
          run.right = rect.right;
        } else {
          flush();
          run = { start: piece.start, end: piece.end, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }
      }
      flush();
    }

    // ---- Pictures ----
    const images: ImageBox[] = [];
    for (const img of body.querySelectorAll("img")) {
      const rect = img.getBoundingClientRect();
      const entry = img.getAttribute("data-kr-src");
      if (!entry || rect.width < 1 || rect.height < 1 || styleOf(img).visibility !== "visible") continue;
      if (!img.naturalWidth) continue; // didn't decode: nothing to draw
      images.push({ source: { path: entry }, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    for (const svg of body.querySelectorAll("svg")) {
      if (svg.parentElement?.closest("svg")) continue;
      const rect = svg.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || styleOf(svg).visibility !== "visible") continue;
      const drawn = [...svg.querySelectorAll("*")].filter(
        (el) => !/^(g|defs|title|desc|metadata|image|style)$/.test(el.localName),
      );
      const pictures = [...svg.querySelectorAll("image")];
      const only = pictures.length === 1 && drawn.length === 0 ? pictures[0] : null;
      if (only?.getAttribute("data-kr-src")) {
        // The common cover: an <svg> scaling one picture to fit.
        const box = only.getBoundingClientRect();
        const fitted = (only.getAttribute("preserveAspectRatio") ?? "").trim() !== "none";
        images.push({
          source: { path: only.getAttribute("data-kr-src")! },
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          ...(fitted ? { fit: "contain" as const } : {}),
        });
        continue;
      }
      // Anything else is drawn as the browser renders it, at this size.
      const copy = svg.cloneNode(true) as SVGSVGElement;
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      copy.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
      copy.setAttribute("width", String(rect.width));
      copy.setAttribute("height", String(rect.height));
      for (const image of copy.querySelectorAll("image")) {
        const entry = image.getAttribute("data-kr-src");
        const url = entry ? dataUrl(entry) : null;
        if (!url) continue;
        image.setAttribute("href", url);
        image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", url);
      }
      images.push({
        source: { svg: new XMLSerializer().serializeToString(copy) },
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }

    // ---- Shading, rules, anchors, links, page breaks, headings ----
    const boxes: FilledBox[] = [];
    const anchors = new Map<string, number>();
    const links: LinkBox[] = [];
    const breaks: number[] = [];
    const headings: HeadingMark[] = [];
    for (const el of [body, ...body.querySelectorAll("*")]) {
      if (el.closest("svg") && el.localName !== "svg") continue;
      const style = styleOf(el);
      if (style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      const id = el.getAttribute("id") ?? (el.localName === "a" ? el.getAttribute("name") : null);
      if (id && !anchors.has(id)) anchors.set(id, rect.top);

      if (el !== body && style.visibility === "visible") {
        const background = parseColor(style.backgroundColor);
        if (background && background.alpha > 0.05 && !isNearWhite(onWhite(background))) {
          const color = onWhite(background);
          const rects = style.display.startsWith("inline") && style.display !== "inline-block" ? [...el.getClientRects()] : [rect];
          for (const r of rects) {
            if (r.width > 0 && r.height > 0) boxes.push({ left: r.left, top: r.top, width: r.width, height: r.height, color });
          }
        }
        if (!style.display.startsWith("inline") || style.display === "inline-block") {
          const sides = [
            ["Top", rect.left, rect.top, rect.width, 0],
            ["Bottom", rect.left, rect.bottom, rect.width, 0],
            ["Left", rect.left, rect.top, 0, rect.height],
            ["Right", rect.right, rect.top, 0, rect.height],
          ] as const;
          for (const [side, x, y, w, h] of sides) {
            const width = parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`));
            const lineStyle = style.getPropertyValue(`border-${side.toLowerCase()}-style`);
            const color = parseColor(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
            if (!(width > 0) || /^(none|hidden)$/.test(lineStyle) || !color || color.alpha < 0.05) continue;
            const shade = onWhite(color);
            if (isNearWhite(shade)) continue;
            boxes.push({
              left: side === "Right" ? x - width : x,
              top: side === "Bottom" ? y - width : y,
              width: w || width,
              height: h || width,
              color: shade,
            });
          }
        }
      }

      if (el.localName === "a" && el.hasAttribute("href")) {
        const href = el.getAttribute("href")!;
        const target = resolveHref(path, href);
        const external = !target && /^(https?:|mailto:)/i.test(href.trim());
        if (target || external) {
          for (const r of el.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            links.push({
              target: target ? anchorKey(target.path, target.fragment) : href.trim(),
              external,
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
            });
          }
        }
      }

      const before = style.getPropertyValue("break-before") || style.getPropertyValue("page-break-before");
      const after = style.getPropertyValue("break-after") || style.getPropertyValue("page-break-after");
      if (/^(page|always|left|right|recto|verso)$/.test(before)) breaks.push(rect.top);
      if (/^(page|always|left|right|recto|verso)$/.test(after)) breaks.push(rect.bottom);

      const level = /^h([1-6])$/.exec(el.localName);
      if (level) {
        const title = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (title) headings.push({ level: Number(level[1]), title, top: rect.top });
      }
    }

    // ---- Baselines ----
    // Measured once per face and size, from where an empty inline-block —
    // which sits on the baseline — lands relative to the text's box.
    const offsets = new Map<string, number>();
    const probeHost = doc.createElement("div");
    probeHost.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;";
    const probes: { key: string; text: Text; mark: HTMLElement }[] = [];
    for (const run of texts) {
      const key = `${run.font}|${run.size}`;
      if (offsets.has(key)) continue;
      offsets.set(key, NaN);
      const span = doc.createElement("span");
      const mono = run.font.startsWith("mono");
      span.style.cssText = `font-family:"${mono ? FAMILY.mono : FAMILY.serif}","${FAMILY.fallback}" !important;font-size:${run.size}px;font-weight:${run.font.includes("bold") ? 700 : 400};font-style:${run.italic ? "italic" : "normal"};line-height:normal;`;
      const text = doc.createTextNode("Hx");
      const mark = doc.createElement("span");
      mark.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;";
      span.append(text, mark);
      probeHost.appendChild(span);
      probeHost.appendChild(doc.createElement("br"));
      probes.push({ key, text, mark });
    }
    body.appendChild(probeHost);
    for (const probe of probes) {
      range.selectNodeContents(probe.text);
      const textTop = range.getBoundingClientRect().top;
      offsets.set(probe.key, probe.mark.getBoundingClientRect().bottom - textTop);
    }
    probeHost.remove();

    const runs: TextRun[] = texts.map(({ weight: _weight, italic: _italic, ...run }) => {
      const offset = offsets.get(`${run.font}|${run.size}`);
      return { ...run, baseline: run.top + (Number.isFinite(offset) ? offset! : (run.bottom - run.top) * 0.8) };
    });

    const chapter: LaidOutChapter = { path, texts: runs, images, boxes, links, anchors, breaks, headings };
    // A page that's only a picture (a cover, a plate) gets the whole page.
    const words = runs.reduce((count, run) => count + run.text.replace(/\s/g, "").length, 0);
    const [only] = images;
    if (images.length === 1 && words === 0 && (only.width > column.width / 2 || only.height > column.height / 3)) {
      chapter.fullPageImage = only;
    }
    return chapter;
  };

  return {
    layoutChapter,
    dispose() {
      frame.remove();
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
    },
  };
}
