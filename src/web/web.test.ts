import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { cleanArticle } from "./cleanup.ts";
import { extractArticle } from "./extract.ts";
import { classifyResource, decodeHtml, isPlaceholderSrc, parseSrcset, pickSrcsetCandidate } from "./html.ts";
import { parsePrintedDate, readMetadata, splitNames } from "./metadata.ts";
import { describeEmbed, preparePage, tagElements } from "./prepare.ts";
import { rewriteCss } from "./renderer.ts";
import { arxivId, canonicalizeUrl, fileNameFor, looksLikeUrl, nameFromUrl, parseUserUrl, rewriteKnownUrl } from "./url.ts";

const PAGE = "https://example.com/blog/post";

function page(html: string): Document {
  const { document } = parseHTML(`<!doctype html><html lang="en">${html}</html>`);
  tagElements(document);
  return document;
}

const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

// A realistic stretch of article text, so the article extractor has
// something to score.
const PROSE = Array.from(
  { length: 6 },
  (_, i) =>
    `<p>Paragraph ${i + 1} of the article explains, at some length and with care, how the system behaves under load, why the design was chosen, and what the trade-offs are for the people who run it every day.</p>`,
).join("\n");

// ---- Addresses ------------------------------------------------------------------

test("parseUserUrl takes what a reader types", () => {
  assert.equal(parseUserUrl("example.com/post")?.href, "https://example.com/post");
  assert.equal(parseUserUrl("  https://example.com/a?b=1  ")?.href, "https://example.com/a?b=1");
  assert.equal(parseUserUrl("localhost:8000/book/")?.href, "https://localhost:8000/book/");
  assert.equal(parseUserUrl("not a url"), null);
  assert.equal(parseUserUrl("hello"), null);
  assert.equal(parseUserUrl("ftp://example.com/file"), null);
  assert.equal(parseUserUrl("javascript:alert(1)"), null);
  assert.ok(looksLikeUrl("https://example.com/x"));
  assert.ok(!looksLikeUrl("see https://example.com/x"));
  assert.ok(!looksLikeUrl("example.com"));
});

test("canonicalizeUrl ignores tracking, fragments, ports and trailing slashes", () => {
  assert.equal(
    canonicalizeUrl("https://Example.com:443/post/?utm_source=x&b=2&a=1&fbclid=y#section"),
    "https://example.com/post?a=1&b=2",
  );
  assert.equal(canonicalizeUrl("http://example.com:80/"), "http://example.com/");
  assert.equal(canonicalizeUrl("https://example.com/watch?v=abc&si=share"), "https://example.com/watch?v=abc");
});

test("an arXiv abstract page leads to the paper's PDF", () => {
  assert.equal(arxivId("https://arxiv.org/abs/1706.03762"), "1706.03762");
  assert.equal(arxivId("https://arxiv.org/pdf/1706.03762v7"), "1706.03762v7");
  assert.equal(arxivId("https://arxiv.org/pdf/2005.14165.pdf"), "2005.14165");
  assert.equal(arxivId("https://export.arxiv.org/abs/hep-th/9901001"), "hep-th/9901001");
  assert.equal(arxivId("https://arxiv.org/list/cs.CL/recent"), null);
  assert.equal(arxivId("https://example.com/abs/1706.03762"), null);
  assert.equal(rewriteKnownUrl(new URL("https://arxiv.org/abs/1706.03762v2")).href, "https://arxiv.org/pdf/1706.03762v2");
  assert.equal(rewriteKnownUrl(new URL(PAGE)).href, PAGE);
});

test("file names come from titles and addresses", () => {
  assert.equal(fileNameFor('A/B: "C"?'), "A B C.pdf");
  assert.equal(fileNameFor("   "), "Web page.pdf");
  assert.equal(nameFromUrl("https://example.com/papers/attention.pdf"), "attention");
  assert.equal(nameFromUrl("https://example.com/"), "example.com");
});

// ---- Bytes ------------------------------------------------------------------------

test("classifyResource goes by the bytes before the label", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  assert.equal(classifyResource("text/html", bytes("%PDF-1.7 …")), "pdf");
  assert.equal(classifyResource("application/octet-stream", bytes("<!DOCTYPE html><html>")), "html");
  assert.equal(classifyResource("", bytes("﻿<html><body>")), "html");
  assert.equal(classifyResource("text/plain; charset=utf-8", bytes("just text")), "text");
  assert.equal(classifyResource("image/png", bytes("\x89PNG")), "image");
  assert.equal(classifyResource("application/epub+zip", bytes("PK…")), "epub");
});

test("decodeHtml honours the declared encoding", () => {
  const latin1 = Uint8Array.from([...'<meta charset="windows-1252"><p>caf'].map((c) => c.charCodeAt(0)).concat([0xe9]));
  assert.match(decodeHtml(latin1), /café/);
  const utf8 = new TextEncoder().encode("<p>naïve</p>");
  assert.match(decodeHtml(utf8, "text/html; charset=utf-8"), /naïve/);
});

test("srcset: parsed as browsers do, the sharpest picture that fits chosen", () => {
  const candidates = parseSrcset("https://cdn.example.com/c_scale,w_400/a.jpg 400w, https://cdn.example.com/c_scale,w_1200/a.jpg 1200w, https://cdn.example.com/c_scale,w_3000/a.jpg 3000w");
  assert.deepEqual(candidates.map((c) => c.width), [400, 1200, 3000]);
  assert.equal(candidates[0].url, "https://cdn.example.com/c_scale,w_400/a.jpg");
  assert.equal(pickSrcsetCandidate(candidates)?.width, 1200);
  assert.equal(pickSrcsetCandidate(parseSrcset("a.png 1x, b.png 2x, c.png 3x"))?.url, "b.png");
  assert.equal(pickSrcsetCandidate(parseSrcset("only.png"))?.url, "only.png");
  assert.ok(isPlaceholderSrc("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"));
  assert.ok(isPlaceholderSrc("/img/placeholder.png"));
  assert.ok(!isPlaceholderSrc("https://example.com/photo.jpg"));
});

// ---- Metadata ------------------------------------------------------------------------

test("metadata: the visible title, a printed byline and date", () => {
  const doc = page(`<head><title>Designing failover | Example Developers</title>
    <meta property="og:title" content="Designing failover">
    <meta property="og:site_name" content="Example Developers">
    <meta name="description" content="Why direct access matters for previews."></head>
    <body><main><header><span>Oct 14, 2026</span><h1>Designing failover</h1>
    <p>Why direct access matters for previews.</p><p><span>Authors:</span> Ada Lovelace, Charles Babbage</p></header>
    <article>${PROSE}</article></main></body>`);
  const meta = readMetadata(doc, PAGE);
  assert.equal(meta.title, "Designing failover");
  assert.equal(meta.siteName, "Example Developers");
  assert.deepEqual(meta.authors, ["Ada Lovelace", "Charles Babbage"]);
  assert.equal(meta.publishedAt, "2026-10-14");
  assert.equal(meta.dek, "Why direct access matters for previews.");
  assert.ok(meta.titleId);
});

test("metadata: a site name in the <h1> loses to the article's own heading", () => {
  const doc = page(`<head><title>Things we learned</title><meta property="og:title" content="Things we learned"></head>
    <body><header><h1>Someone's Weblog</h1></header><div><h2>Things we learned</h2>${PROSE}</div></body>`);
  assert.equal(readMetadata(doc, PAGE).title, "Things we learned");
});

test("metadata: a labelled heading, structured data, citation tags", () => {
  const doc = page(`<head><meta name="citation_title" content="Attention Is All You Need">
    <meta name="citation_author" content="Vaswani, Ashish"><meta name="citation_author" content="Shazeer, Noam">
    <meta name="citation_date" content="2017/06/12"><meta name="citation_pdf_url" content="/pdf/1706.03762">
    <script type="application/ld+json">{"@type":"ScholarlyArticle","author":{"@type":"Organization","name":"Org"}}</script></head>
    <body><h1><span>Title:</span>Attention Is All You Need</h1></body>`);
  const meta = readMetadata(doc, "https://arxiv.org/abs/1706.03762");
  assert.equal(meta.title, "Attention Is All You Need");
  assert.deepEqual(meta.authors, ["Ashish Vaswani", "Noam Shazeer"]);
  assert.equal(meta.publishedAt, "2017-06-12");
  assert.equal(meta.pdfUrl, "https://arxiv.org/pdf/1706.03762");
});

test("metadata: a closing 'Written by' line names the authors", () => {
  const doc = page(`<head><script type="application/ld+json">{"@type":"Article","headline":"Post","author":{"@type":"Organization","name":"Acme"}}</script></head>
    <body><article><h1>Post</h1>${PROSE}<p>Written by Lance Martin, Gabe Cemaj, and Michael Cohen. Thanks to Jeremy Fox for helpful conversations.</p></article></body>`);
  assert.deepEqual(readMetadata(doc, PAGE).authors, ["Lance Martin", "Gabe Cemaj", "Michael Cohen"]);
});

test("names and dates as pages print them", () => {
  assert.deepEqual(splitNames("By Ada Lovelace and Charles Babbage."), ["Ada Lovelace", "Charles Babbage"]);
  assert.equal(parsePrintedDate("Published March 9, 2019"), "2019-03-09");
  assert.equal(parsePrintedDate("9th Sept 2021"), "2021-09-09");
  assert.equal(parsePrintedDate("no date here"), null);
});

// ---- Preparing a page ---------------------------------------------------------------

test("pictures loaded by script get a plain src", () => {
  const doc = page(`<body>
    <img id="lazy" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/real.jpg">
    <picture><source srcset="/img/p-800.webp 800w, /img/p-1600.webp 1600w" type="image/webp"><img id="pic" src="/img/p-400.jpg"></picture>
    <img id="placeholder" src="/img/blank.gif"><noscript><img src="/img/behind.jpg"></noscript>
  </body>`);
  preparePage(doc, PAGE);
  assert.equal(doc.getElementById("lazy")?.getAttribute("src"), "https://example.com/img/real.jpg");
  assert.equal(doc.getElementById("pic")?.getAttribute("src"), "https://example.com/img/p-1600.webp");
  assert.equal(doc.querySelector("picture"), null);
  assert.equal(doc.getElementById("placeholder"), null);
  assert.ok(doc.querySelector('img[src="https://example.com/img/behind.jpg"]'));
});

test("video, audio and embeds become links with a picture where there is one", () => {
  const doc = page(`<body>
    <iframe src="https://www.youtube.com/embed/k1ILy23t89E" title="Talk"></iframe>
    <audio src="/audio/episode.mp3"></audio>
    <iframe src="https://googleads.g.doubleclick.net/x" width="1" height="1"></iframe>
    <script src="https://gist.github.com/someone/abc123.js"></script>
  </body>`);
  preparePage(doc, PAGE);
  const cards = [...doc.querySelectorAll("[data-kr-media]")];
  assert.deepEqual(cards.map((card) => card.getAttribute("data-kr-media")), ["video", "audio", "code"]);
  assert.equal(cards[0].querySelector("img")?.getAttribute("src"), "https://i.ytimg.com/vi/k1ILy23t89E/hqdefault.jpg");
  assert.equal(cards[0].querySelector("a")?.getAttribute("href"), "https://www.youtube.com/watch?v=k1ILy23t89E");
  assert.equal(cards[1].querySelector("a")?.getAttribute("href"), "https://example.com/audio/episode.mp3");
  assert.equal(doc.querySelector("iframe"), null);
  assert.equal(describeEmbed("https://player.vimeo.com/video/123")?.url, "https://vimeo.com/123");
});

test("formulas become their TeX", () => {
  const doc = page(`<body><p>Inline <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">x2</span></span> and
    <span class="katex-display"><span class="katex"><math><semantics><mi>y</mi><annotation encoding="application/x-tex">\\frac{a}{b}</annotation></semantics></math></span></span></p>
    <p><math alttext="{\\displaystyle P(A)}"><mi>P</mi></math></p></body>`);
  preparePage(doc, PAGE);
  const math = [...doc.querySelectorAll("[data-kr-math]")].map((el) => [el.getAttribute("data-kr-math"), el.textContent]);
  assert.deepEqual(math, [
    ["inline", "$x^2$"],
    ["display", "$$\\frac{a}{b}$$"],
    ["inline", "$P(A)$"],
  ]);
  assert.ok(!text(doc.body).includes("x2"));
});

test("figures drawn with CSS are set aside for capture; ordinary figures aren't", () => {
  const doc = page(`<body>
    <figure id="diagram"><div role="img" aria-label="Requests flow from the app to the router.">
      <div class="node"><strong>App</strong><span>Owner</span></div><svg viewBox="0 0 10 10"><path d="M0 0H10"/></svg>
      <div class="node"><strong>Router</strong><span>Policy</span></div></div></figure>
    <figure id="photo"><img src="/a.jpg"><figcaption>A photo, with a caption of some length.</figcaption></figure>
    <figure id="code"><pre>let x = 1;</pre><figcaption>Listing 1</figcaption></figure>
  </body>`);
  const { islands } = preparePage(doc, PAGE);
  assert.equal(islands.size, 1);
  const [island] = islands.values();
  assert.equal(island.alt, "Requests flow from the app to the router.");
  assert.match(island.text, /App Owner Router Policy/);
  assert.ok(doc.querySelector('[data-kr-island] img[src^="kr-island:"]'));
  assert.ok(doc.querySelector("figure img[src='https://example.com/a.jpg']"));
  assert.ok(doc.querySelector("figure pre"));
});

test("content a script would reveal is revealed", () => {
  const doc = page(`<body><section style="visibility:hidden"><p>Fades in on scroll.</p></section>
    <div style="opacity: 0; transform: translateY(20px)">Also fades in.</div>
    <button role="tab" id="t2" aria-controls="p2">Python</button>
    <div role="tabpanel" id="p2" aria-labelledby="t2" hidden><pre>print(1)</pre></div></body>`);
  preparePage(doc, PAGE);
  assert.ok(!/visibility/.test(doc.querySelector("section")?.getAttribute("style") ?? ""));
  assert.ok(!/opacity/.test(doc.querySelector("div")?.getAttribute("style") ?? ""));
  const panel = doc.getElementById("p2")!;
  assert.ok(!panel.hasAttribute("hidden"));
  assert.equal(text(panel.querySelector("strong")), "Python");
});

// ---- Finding the article ------------------------------------------------------------

function extract(html: string) {
  const doc = page(html);
  const meta = readMetadata(doc, PAGE);
  const prepared = preparePage(doc, PAGE, meta.canonicalUrl);
  const result = extractArticle(prepared, meta);
  cleanArticle(result.content, meta.title);
  return { ...result, text: text(result.content), html: result.content.innerHTML };
}

test("the article is kept, the site around it isn't", () => {
  const { text: article } = extract(`<head><title>Post</title></head><body>
    <nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
    <main><article><h1>Post</h1>${PROSE}</article></main>
    <aside class="newsletter"><p>Subscribe to our newsletter for weekly updates about everything.</p></aside>
    <footer><p>© Example Inc. All rights reserved. Terms, privacy and cookie settings.</p></footer></body>`);
  assert.match(article, /Paragraph 1 of the article/);
  assert.match(article, /Paragraph 6 of the article/);
  assert.doesNotMatch(article, /Subscribe|All rights reserved|About/);
});

test("words cut from the middle of a kept paragraph are put back", () => {
  // Readability removes any element whose class looks unlikely to it — here
  // "popup", as in Wikipedia's pronunciation guides ("nopopups").
  const { text: article } = extract(`<head><title>Bayes</title></head><body><article><h1>Bayes</h1>
    <p>Bayes' theorem, named after Thomas Bayes (<span class="IPA nopopups">/beɪz/</span>), gives a rule for inverting conditional probabilities, which lets the probability of a cause be found from its effect.</p>
    ${PROSE}</article></body>`);
  assert.match(article, /Thomas Bayes \(\/beɪz\/\)/);
});

test("a section the page hides until it scrolls into view is kept", () => {
  const { text: article } = extract(`<head><title>Post</title></head><body><article><h1>Post</h1>${PROSE}
    <section style="visibility:hidden"><h2>Acknowledgements</h2><p>Written by Ada Lovelace. Thanks to <a href="/c">Charles</a> and <a href="/m">Mary</a> for helpful conversations on these topics.</p></section>
    </article></body>`);
  assert.match(article, /Acknowledgements/);
  assert.match(article, /Thanks to Charles and Mary/);
});

test("a boxed sidebar in the text is kept, as a box", () => {
  const { html } = extract(`<head><title>Post</title></head><body><main><div class="body">${PROSE}
    <aside class="sidebar"><h3>How big is a microservice?</h3><p>Although the name invites a focus on size, the teams we spoke to ran services of every size, from a handful of people to dozens.</p></aside>
    ${PROSE}</div></main></body>`);
  assert.match(html, /How big is a microservice\?/);
  assert.match(html, /<aside[^>]*>/);
});

test("end matter outside the article's element comes along", () => {
  const { text: article } = extract(`<head><title>Post</title></head><body><main><div class="paperBody">${PROSE}</div>
    <div class="appendix"><h2>Further Reading</h2><ul><li><a href="https://a.example">Enterprise Integration Patterns</a></li><li><a href="https://b.example">Release It!</a></li></ul></div>
    </main></body>`);
  assert.match(article, /Further Reading/);
  assert.match(article, /Enterprise Integration Patterns/);
});

test("nothing is restored twice", () => {
  const { html } = extract(`<head><title>Post</title></head><body><article><h1>Post</h1>${PROSE}
    <p>The term was coined at a workshop of software architects near Venice in May 2011.<sup><a href="#fn1">1</a></sup></p></article>
    <div class="appendix"><h2>Footnotes</h2><p id="fn1">The term was coined at a workshop of software architects near Venice in May 2011.</p></div></body>`);
  assert.equal(html.split("near Venice").length - 1, 1);
});

test("cleanup drops controls, permalinks and empty leftovers", () => {
  const { document } = parseHTML(`<div id="c"><h2 id="s">Setup <a href="#s">#</a></h2><p>Run it. <button>Copy</button></p><div><span></span></div><p class="note" style="color:red">Kept<a href="/x"> <span class="sr-only">(opens in a new tab)</span>link</a></p></div>`);
  const content = document.getElementById("c") as unknown as HTMLElement;
  cleanArticle(content, "Title");
  assert.equal(text(content.querySelector("h2")), "Setup");
  assert.equal(content.querySelector("button"), null);
  assert.equal(content.querySelectorAll("div").length, 0);
  assert.equal(content.querySelector("p.note"), null); // classes go
  assert.equal(text(content.querySelectorAll("p")[1]), "Kept link");
});

// ---- The styled render's stylesheets -------------------------------------------------

test("rewriteCss routes url()s through the server and switches dark mode off", () => {
  const { css, imports } = rewriteCss(
    `@import url("base.css") screen; .a { background: url(img/bg.png) } .b { src: url('data:font/woff2;base64,AAA') }
     @media (prefers-color-scheme: dark) { body { background: black } } @media (prefers-color-scheme: light) { body { color: #111 } }`,
    "https://example.com/css/site.css",
    (url) => `/proxy?u=${encodeURIComponent(url)}`,
  );
  assert.deepEqual(imports, [{ url: "https://example.com/css/base.css", media: "screen" }]);
  assert.match(css, /url\("\/proxy\?u=https%3A%2F%2Fexample\.com%2Fcss%2Fimg%2Fbg\.png"\)/);
  assert.match(css, /data:font\/woff2/);
  assert.match(css, /prefers-color-scheme: kr-never/);
  assert.match(css, /\(min-width: 0px\)/);
  assert.doesNotMatch(css, /@import/);
});
