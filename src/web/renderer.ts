import { absolutize, ID_ATTR, revealScripted, settlePictures } from "./prepare.ts";
import { decodeHtml } from "./html.ts";
import type { WebFetcher } from "./types.ts";

// A styled render of the original page — its own stylesheets, fonts and
// pictures — that parts of it can be captured from: figures drawn with CSS
// (as pictures) and inline SVG (made standalone, its CSS-set colours and
// strokes written into it). Elements are named by the data-kr-id they were
// given when the page was read (prepare.ts), so the render and the extracted
// article agree on what's what.
//
// The app's renderer is a hidden frame with scripts off, capturing with
// html2canvas. A headless browser (Playwright, Puppeteer) could implement
// the same interface: load the page, then screenshot `[data-kr-id=…]`.

export interface Snapshot {
  png: Uint8Array;
  width: number; // CSS pixels, as the element was laid out on the page
  height: number;
}

export interface StandaloneSvg {
  svg: string;
  width: number;
  height: number;
}

export interface RenderedPage {
  snapshot(id: string): Promise<Snapshot | null>;
  standaloneSvg(id: string): Promise<StandaloneSvg | null>;
  size(id: string): Promise<{ width: number; height: number } | null>;
  close(): void;
}

export interface PageRenderer {
  // `html` is the page as fetched, with data-kr-id on every element.
  open(page: { html: string; url: string }, options?: { signal?: AbortSignal }): Promise<RenderedPage>;
}

const VIEWPORT_WIDTH = 1200;
const LOAD_TIMEOUT_MS = 15_000;
const SNAPSHOT_TIMEOUT_MS = 20_000;
const MAX_FRAME_HEIGHT = 30_000;

// ---- Stylesheets --------------------------------------------------------------------

// A stylesheet's url()s pointed at `toAsset` (absolute, through the app's
// server), and its dark-mode rules switched off — the book's pages are
// white whatever the reader's system theme. Returns the @import targets
// separately, for the caller to fetch and inline.
export function rewriteCss(css: string, cssUrl: string, toAsset: (url: string) => string): { css: string; imports: { url: string; media: string }[] } {
  const imports: { url: string; media: string }[] = [];
  let out = css.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi, (_, _q, href: string, media: string) => {
    try {
      imports.push({ url: new URL(href, cssUrl).href, media: media.trim() });
    } catch {
      // An import that can't be resolved is dropped.
    }
    return "";
  });
  out = out.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (match, dq?: string, sq?: string, bare?: string) => {
    const value = (dq ?? sq ?? bare ?? "").trim();
    if (!value || /^(data:|#|about:)/i.test(value)) return match;
    try {
      return `url("${toAsset(new URL(value, cssUrl).href)}")`;
    } catch {
      return match;
    }
  });
  out = out
    .replace(/prefers-color-scheme\s*:\s*dark/gi, "prefers-color-scheme: kr-never")
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, "(min-width: 0px)");
  return { css: out, imports };
}

// ---- The frame ----------------------------------------------------------------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => fallback)]);
}

// Presentation properties that decide how SVG is drawn, often set by a
// site's CSS rather than on the elements themselves.
const SVG_PROPS = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-dashoffset",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "opacity", "color", "font-family", "font-size", "font-weight",
  "font-style", "text-anchor", "dominant-baseline", "visibility", "stop-color", "stop-opacity", "marker-start", "marker-mid",
  "marker-end", "paint-order", "clip-rule", "mask", "clip-path",
];

function isBlank(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) return true;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const stride = Math.max(4, Math.floor(data.length / 4 / 40_000) * 4);
  let inked = 0;
  let samples = 0;
  for (let i = 0; i < data.length; i += stride) {
    samples += 1;
    if (data[i + 3] > 10 && (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235)) inked += 1;
  }
  return inked / samples < 0.002;
}

export function frameRenderer(fetcher: WebFetcher): PageRenderer {
  return {
    async open({ html, url }, { signal } = {}) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const baseHref = doc.querySelector("base[href]")?.getAttribute("href");
      let base = url;
      try {
        if (baseHref) base = new URL(baseHref, url).href;
      } catch {
        base = url;
      }
      absolutize(doc, base, [url]);
      settlePictures(doc);
      revealScripted(doc);
      const asset = (target: string) => fetcher.assetUrl(target, url);

      // Nothing that runs or loads other pages: no scripts, frames or
      // plugins, no inline event handlers or javascript: links — and a
      // policy forbidding scripts outright. (The capture copies the page
      // into a frame of the app's own; see snapshot below.)
      doc.querySelectorAll("script, iframe, frame, object, embed, video, audio, base, meta[http-equiv], portal").forEach((el) => el.remove());
      for (const el of doc.querySelectorAll("*")) {
        for (const attr of [...el.attributes]) {
          if (/^on/i.test(attr.name) || attr.name === "srcdoc" || /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
        }
      }
      const policy = doc.createElement("meta");
      policy.setAttribute("http-equiv", "Content-Security-Policy");
      policy.setAttribute("content", "script-src 'none'; object-src 'none'; frame-src 'none'");
      doc.head.prepend(policy);

      // Stylesheets inlined in place, in order, their own references through
      // the server. A stylesheet loaded "asynchronously" by script (the
      // media="print" onload trick, rel=preload as=style) counts as loaded.
      const fetchCss = async (cssUrl: string, depth: number): Promise<string> => {
        try {
          const resource = await fetcher.fetch(cssUrl, { purpose: "asset", referer: url, signal });
          const { css, imports } = rewriteCss(decodeHtml(resource.bytes, resource.contentType), resource.finalUrl, asset);
          if (depth >= 3 || imports.length === 0) return css;
          const inlined = await Promise.all(
            imports.map(async (item) => {
              const text = await fetchCss(item.url, depth + 1);
              return item.media ? `@media ${item.media} {\n${text}\n}` : text;
            }),
          );
          return `${inlined.join("\n")}\n${css}`;
        } catch {
          return "";
        }
      };
      const links = [...doc.querySelectorAll("link")].filter((link) => {
        const rel = (link.getAttribute("rel") ?? "").toLowerCase();
        if (/\balternate\b/.test(rel)) return false;
        return /\bstylesheet\b/.test(rel) || (/\bpreload\b/.test(rel) && link.getAttribute("as") === "style");
      });
      await Promise.all(
        links.map(async (link) => {
          const href = link.getAttribute("href");
          let css = "";
          if (href) {
            try {
              css = await fetchCss(new URL(href, base).href, 0);
            } catch {
              css = "";
            }
          }
          const declared = (link.getAttribute("media") ?? "").trim();
          const media = link.hasAttribute("onload") || /^(all)?$/i.test(declared) ? "" : declared;
          const style = doc.createElement("style");
          style.setAttribute("data-kr-inlined", ""); // already rewritten
          style.textContent = /^print$/i.test(media) ? "" : media ? `@media ${media} {\n${css}\n}` : css;
          link.replaceWith(style);
        }),
      );
      doc.querySelectorAll("link").forEach((link) => link.remove());
      for (const style of doc.querySelectorAll("style:not([data-kr-inlined])")) {
        style.textContent = rewriteCss(style.textContent ?? "", base, asset).css;
      }
      for (const el of doc.querySelectorAll("[style]")) {
        const value = el.getAttribute("style")!;
        if (/url\(/i.test(value)) el.setAttribute("style", rewriteCss(value, base, asset).css);
      }
      for (const img of doc.querySelectorAll("img[src]")) {
        const src = img.getAttribute("src")!;
        if (/^https?:/i.test(src)) img.setAttribute("src", asset(src));
        img.setAttribute("crossorigin", "anonymous"); // so captures may read them
      }
      for (const el of doc.querySelectorAll("svg image")) {
        for (const attr of ["href", "xlink:href"]) {
          const value = el.getAttribute(attr);
          if (value && /^https?:/i.test(value)) el.setAttribute(attr, asset(value));
        }
      }
      const colorScheme = doc.createElement("meta");
      colorScheme.setAttribute("name", "color-scheme");
      colorScheme.setAttribute("content", "light");
      doc.head.prepend(colorScheme);
      const settle = doc.createElement("style");
      settle.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; } html { color-scheme: light; }";
      doc.head.append(settle);

      const frame = document.createElement("iframe");
      // Same origin so it can be read; no scripts, so the page's can't run.
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${VIEWPORT_WIDTH}px;height:1000px;border:0;opacity:0;pointer-events:none;color-scheme:light;`;
      const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
      frame.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
      document.body.appendChild(frame);
      await withTimeout(loaded, LOAD_TIMEOUT_MS, undefined);
      const view = frame.contentWindow;
      const page = frame.contentDocument;
      if (!view || !page) {
        frame.remove();
        throw new Error("The page couldn't be rendered.");
      }
      await withTimeout(page.fonts?.ready ?? Promise.resolve(), 8000, undefined);
      await withTimeout(
        Promise.all(
          [...page.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))),
        ),
        8000,
        undefined,
      );
      // Tall enough that everything is "on screen" for the capture.
      frame.style.height = `${Math.min(MAX_FRAME_HEIGHT, Math.max(1000, page.documentElement.scrollHeight))}px`;
      await sleep(50);

      const find = (id: string) => page.querySelector(`[${ID_ATTR}="${id}"]`);
      let html2canvas: (typeof import("html2canvas-pro"))["default"] | null = null;
      // html2canvas copies the page into a frame of its own to draw it. Made
      // inside the sandboxed frame, WebKit (the desktop app's engine) never
      // lets that copy load; made here, in the app's document, it does — and
      // it's inert: no scripts, handlers or plugins (above).
      const cloneHost = document.createElement("div");
      cloneHost.setAttribute("aria-hidden", "true");
      cloneHost.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      document.body.appendChild(cloneHost);

      return {
        async size(id) {
          const el = find(id);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        },

        async snapshot(id) {
          const el = find(id) as HTMLElement | null;
          if (!el) return null;
          // Shown as a script would show it: a figure that fades in on
          // scroll is still transparent here.
          for (const node of [el, ...el.querySelectorAll<HTMLElement>("*")]) {
            const style = view.getComputedStyle(node);
            if (style.opacity === "0") node.style.setProperty("opacity", "1", "important");
            if (style.visibility === "hidden" && node === el) node.style.setProperty("visibility", "visible", "important");
          }
          for (let node = el.parentElement; node && node !== page.body; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (style.opacity === "0") node.style.setProperty("opacity", "1", "important");
            if (style.visibility === "hidden") node.style.setProperty("visibility", "visible", "important");
            if (style.transform !== "none") node.style.setProperty("transform", "none", "important");
          }
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || rect.height < 2) return null;
          html2canvas ??= (await import("html2canvas-pro")).default;
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), SNAPSHOT_TIMEOUT_MS);
          try {
            const canvas = await html2canvas(el, {
              backgroundColor: "#ffffff",
              scale: 2,
              useCORS: true,
              logging: false,
              imageTimeout: 8000,
              iframeContainer: cloneHost,
              signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
            });
            if (isBlank(canvas)) return null;
            const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
            if (!blob) return null;
            return { png: new Uint8Array(await blob.arrayBuffer()), width: rect.width, height: rect.height };
          } catch (error) {
            console.warn("Couldn't capture a figure:", error);
            return null;
          } finally {
            clearTimeout(timer);
          }
        },

        async standaloneSvg(id) {
          const svg = find(id);
          if (!svg || svg.localName !== "svg") return null;
          const rect = svg.getBoundingClientRect();
          if (rect.width < 1 || rect.height < 1) return null;
          const copy = svg.cloneNode(true) as Element;
          const originals = [svg, ...svg.querySelectorAll("*")];
          const copies = [copy, ...copy.querySelectorAll("*")];
          const hidden: Element[] = [];
          originals.forEach((original, i) => {
            const style = view.getComputedStyle(original);
            if (style.display === "none") {
              hidden.push(copies[i]);
              return;
            }
            copies[i].setAttribute("style", SVG_PROPS.map((prop) => `${prop}:${style.getPropertyValue(prop)}`).join(";"));
            copies[i].removeAttribute("class");
          });
          hidden.forEach((el) => el.remove());
          // Shapes the drawing borrows from elsewhere on the page (an icon
          // sprite sheet), brought in.
          const defs = page.createElementNS("http://www.w3.org/2000/svg", "defs");
          for (const use of copy.querySelectorAll("use")) {
            const ref = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
            if (!ref.startsWith("#")) continue;
            const targetId = ref.slice(1);
            if (copy.querySelector(`[id="${CSS.escape(targetId)}"]`) || defs.querySelector(`[id="${CSS.escape(targetId)}"]`)) continue;
            const target = page.getElementById(targetId);
            if (target) defs.append(target.cloneNode(true));
          }
          if (defs.childNodes.length) copy.prepend(defs);
          copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
          copy.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
          copy.setAttribute("width", String(Math.round(rect.width * 100) / 100));
          copy.setAttribute("height", String(Math.round(rect.height * 100) / 100));
          copy.removeAttribute(ID_ATTR);
          for (const el of copy.querySelectorAll(`[${ID_ATTR}]`)) el.removeAttribute(ID_ATTR);
          return { svg: new XMLSerializer().serializeToString(copy), width: rect.width, height: rect.height };
        },

        close() {
          frame.remove();
          cloneHost.remove();
        },
      };
    },
  };
}
