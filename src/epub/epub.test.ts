import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { markerText } from "./layout.ts";
import { pageAt, paginate } from "./paginate.ts";
import { cssImports, resolveHref, sanitizeCss, sniffImageType } from "./paths.ts";
import type { FontName, LaidOutChapter, TextRun } from "./types.ts";
import { BOOK_PAGE, columnSize, writePdf } from "./writePdf.ts";

// ---- Paths ----

test("resolveHref resolves relative to the file the href is in", () => {
  assert.deepEqual(resolveHref("OEBPS/Text/ch1.xhtml", "../Images/fig%201.png"), {
    path: "OEBPS/Images/fig 1.png",
    fragment: "",
  });
  assert.deepEqual(resolveHref("OEBPS/Text/ch1.xhtml", "ch2.xhtml#sec-2"), { path: "OEBPS/Text/ch2.xhtml", fragment: "sec-2" });
  assert.deepEqual(resolveHref("OEBPS/Text/ch1.xhtml", "#note-3"), { path: "OEBPS/Text/ch1.xhtml", fragment: "note-3" });
  assert.deepEqual(resolveHref("content.opf", "./text/a.xhtml"), { path: "text/a.xhtml", fragment: "" });
  assert.equal(resolveHref("a.xhtml", "https://example.com/x"), null);
  assert.equal(resolveHref("a.xhtml", "mailto:someone@example.com"), null);
});

test("sanitizeCss drops what a stylesheet would fetch", () => {
  const css = `@import url("base.css");
@font-face { font-family: X; src: url(fonts/x.otf); }
/* comment */ p { background: url('bg.png') no-repeat; text-indent: 1em; }`;
  const clean = sanitizeCss(css);
  assert.ok(!clean.includes("url("));
  assert.ok(!clean.includes("@font-face"));
  assert.ok(!clean.includes("@import"));
  assert.match(clean, /text-indent: 1em/);
  assert.deepEqual(cssImports(css), ["base.css"]);
  assert.deepEqual(cssImports(`@import "a.css"; @import url(b.css) screen;`), ["a.css", "b.css"]);
});

test("sniffImageType goes by the bytes, not the name", () => {
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "png");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a")), "gif");
  assert.equal(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="…"/>')), "svg");
});

// ---- List markers ----

test("markerText numbers and bullets list items", () => {
  assert.equal(markerText("disc", 1), "•");
  assert.equal(markerText("decimal", 12), "12.");
  assert.equal(markerText("lower-alpha", 28), "ab.");
  assert.equal(markerText("upper-roman", 14), "XIV.");
  assert.equal(markerText("none", 1), null);
  assert.equal(markerText('"– "', 1), "– ");
});

// ---- Pagination ----

const lines = (count: number, height = 20, from = 0) =>
  Array.from({ length: count }, (_, i) => ({ top: from + i * height, bottom: from + i * height + 16 }));

test("paginate never cuts a line in half", () => {
  const pages = paginate(lines(25), 100);
  // 5 lines fit in 100px (the 6th, at 100–116, would cross the bottom).
  assert.deepEqual(pages, [0, 100, 200, 300, 400]);
  const odd = paginate(lines(10, 30), 100);
  // 0,30,60 fit; 90–106 crosses, so page 2 starts at 90.
  assert.deepEqual(odd, [0, 90, 180, 270]);
  for (const [i, start] of odd.entries()) {
    const end = odd[i + 1] ?? Infinity;
    for (const line of lines(10, 30)) if (line.top >= start && line.top < end) assert.ok(line.bottom <= start + 100);
  }
});

test("paginate honours the book's page breaks", () => {
  const pages = paginate([...lines(2), ...lines(2, 20, 300)], 1000, [300]);
  assert.deepEqual(pages, [0, 300]);
  // A break before anything is on the page doesn't make an empty page.
  assert.deepEqual(paginate(lines(2, 20, 50), 1000, [50]), [0]);
});

test("paginate moves a heading left at a page's foot to the next page", () => {
  const items = [...lines(4), { top: 80, bottom: 96, keepWithNext: true }, ...lines(3, 20, 100)];
  assert.deepEqual(paginate(items, 100), [0, 80]);
});

test("paginate starts each page with its first line, not the gap above it", () => {
  assert.deepEqual(paginate([{ top: 0, bottom: 16 }, { top: 150, bottom: 166 }], 100), [0, 150]);
  assert.equal(pageAt([0, 150], 149), 0);
  assert.equal(pageAt([0, 150], 150), 1);
});

// ---- Writing the PDF ----

const fonts: Record<FontName, Uint8Array> = {
  serif: readFileSync("node_modules/@expo-google-fonts/literata/400Regular/Literata_400Regular.ttf"),
  "serif-bold": readFileSync("node_modules/@expo-google-fonts/literata/700Bold/Literata_700Bold.ttf"),
  "serif-italic": readFileSync("node_modules/@expo-google-fonts/literata/400Regular_Italic/Literata_400Regular_Italic.ttf"),
  "serif-bold-italic": readFileSync("node_modules/@expo-google-fonts/literata/700Bold_Italic/Literata_700Bold_Italic.ttf"),
  mono: readFileSync("node_modules/dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf"),
  "mono-bold": readFileSync("node_modules/dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf"),
  fallback: readFileSync("node_modules/dejavu-fonts-ttf/ttf/DejaVuSans.ttf"),
};

const run = (text: string, top: number, extra: Partial<TextRun> = {}): TextRun => ({
  text,
  left: 0,
  top,
  bottom: top + 20,
  baseline: top + 16,
  font: "serif",
  size: 16,
  color: [0, 0, 0],
  ...extra,
});

const chapter = (path: string, texts: TextRun[], extra: Partial<LaidOutChapter> = {}): LaidOutChapter => ({
  path,
  texts,
  images: [],
  boxes: [],
  links: [],
  anchors: new Map(),
  breaks: [],
  headings: [],
  ...extra,
});

test("writePdf writes the book's text, pages, outline and links", async () => {
  const column = columnSize(BOOK_PAGE);
  const longChapter = Array.from({ length: 60 }, (_, i) => run(`Line ${i} of chapter two`, 40 + i * 24));
  const bytes = await writePdf({
    title: "A Test Book",
    authors: ["Ada Author", "Bo Writer"],
    language: "en",
    toc: [
      {
        title: "One",
        target: "text/one.xhtml",
        children: [{ title: "Further on", target: "text/one.xhtml#later", children: [] }],
      },
      { title: "Two", target: "text/two.xhtml", children: [] },
      { title: "Nowhere", target: "text/missing.xhtml", children: [] },
    ],
    chapters: [
      chapter(
        "text/one.xhtml",
        [
          run("Chapter One", 0, { font: "serif-bold", size: 24, keepWithNext: true }),
          run("Café — naïve, with ∀x ∈ ℝ math", 40),
          run("See chapter two", 64, { font: "serif-italic" }),
        ],
        {
          anchors: new Map([["later", 64]]),
          links: [{ target: "text/two.xhtml", external: false, left: 0, top: 64, width: 120, height: 20 }],
        },
      ),
      chapter("text/two.xhtml", longChapter),
    ],
    fonts,
    loadImage: async () => null,
  });

  const pdf = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const pagesForTwo = Math.ceil((40 + 60 * 24) / column.height);
  assert.equal(pdf.numPages, 1 + pagesForTwo);

  const { info } = await pdf.getMetadata();
  assert.equal((info as { Title?: string }).Title, "A Test Book");
  assert.equal((info as { Author?: string }).Author, "Ada Author, Bo Writer");

  const firstText = (await (await pdf.getPage(1)).getTextContent()).items
    .map((item) => ("str" in item ? item.str : ""))
    .join("");
  assert.match(firstText, /Chapter One/);
  assert.match(firstText, /Café — naïve, with ∀x ∈ ℝ math/);

  const outline = await pdf.getOutline();
  assert.deepEqual(
    outline.map((item) => item.title),
    ["One", "Two"],
  );
  assert.equal(outline[0].items[0].title, "Further on");
  const twoDest = outline[1].dest as unknown[];
  assert.equal(await pdf.getPageIndex(twoDest[0] as never), 1);

  const annotations = await (await pdf.getPage(1)).getAnnotations();
  const link = annotations.find((annotation) => annotation.subtype === "Link");
  assert.ok(link);
  assert.equal(await pdf.getPageIndex((link.dest as unknown[])[0] as never), 1);

  // Every line of chapter two is on some page, in order.
  const all: string[] = [];
  for (let i = 2; i <= pdf.numPages; i += 1) {
    const content = await (await pdf.getPage(i)).getTextContent();
    all.push(...content.items.map((item) => ("str" in item ? item.str : "")).filter((s) => s.trim()));
  }
  assert.deepEqual(all, longChapter.map((r) => r.text));
  await pdf.destroy();
});

test("writePdf builds an outline from headings when the book has no table of contents", async () => {
  const bytes = await writePdf({
    authors: [],
    toc: [],
    chapters: [
      chapter("a.xhtml", [run("Part I", 0), run("Section", 40)], {
        headings: [
          { level: 1, title: "Part I", top: 0 },
          { level: 2, title: "Section", top: 40 },
        ],
      }),
      chapter("b.xhtml", [run("Part II", 0)], { headings: [{ level: 1, title: "Part II", top: 0 }] }),
    ],
    fonts,
    loadImage: async () => null,
  });
  const pdf = await getDocument({ data: bytes }).promise;
  const outline = await pdf.getOutline();
  assert.deepEqual(
    outline.map((item) => [item.title, item.items.map((child) => child.title)]),
    [
      ["Part I", ["Section"]],
      ["Part II", []],
    ],
  );
  await pdf.destroy();
});
