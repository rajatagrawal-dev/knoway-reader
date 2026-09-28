import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfHighlighterUtils } from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchorRect } from "../deepdive/useFlippedPlacement";
import GlossaryHoverCard from "./GlossaryHoverCard";
import { getTextIndex } from "./job";
import { useGlossaryEntries, type GlossaryStore } from "./store";
import {
  buildTermMatcher,
  findTermMarksOnPage,
  matchPosition,
  type DocumentTextIndex,
  type IndexedPage,
  type PageTermMark,
  type TermMatcher,
} from "./textIndex";

// Dotted underlines under every occurrence of a glossary term (and its
// related forms — "entangled" for "entanglement") in the PDF, with the
// definition shown on hover.
//
// The underlines are plain DOM, not react-pdf-highlighter highlights: a
// common term can occur thousands of times, and they need no interaction of
// their own. Each rendered page gets one layer of absolutely positioned
// divs, sized in percentages of the page so zooming needs no recompute. The
// layer ignores the pointer (text selection works through it as before);
// hovering is detected by hit-testing pointer moves against the marks
// instead.

const LAYER_CLASS = "glossary-marks-layer";
const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 200;

interface Box {
  left: number; // fractions of the page's width/height
  top: number;
  width: number;
  height: number;
}

interface Mark {
  entryId: string;
  text: string;
  boxes: Box[];
}

// pdf.js's text layer has one span per text run, in the same order as the
// runs the index was built from (minus the ones it dropped, e.g. running
// heads) — pair each indexed run with its span's text node.
function runTextNodes(pageDiv: HTMLElement, page: IndexedPage): (Text | null)[] {
  const spans = [...pageDiv.querySelectorAll<HTMLElement>(".textLayer span")].filter((span) => !span.firstElementChild);
  let next = 0;
  return page.items.map((item) => {
    for (let k = next; k < Math.min(spans.length, next + 40); k += 1) {
      if (spans[k].textContent === item.text) {
        next = k + 1;
        const node = spans[k].firstChild;
        return node instanceof Text ? node : null;
      }
    }
    return null;
  });
}

// Where the matched characters are drawn, measured from the text layer —
// the same geometry the browser uses to paint a selection of them. The
// index's own rects only interpolate across a run by character count,
// which drifts by a character or two within a long run of proportional
// text. Null if any run's span can't be found.
function measureBoxes(match: PageTermMark, nodes: (Text | null)[], pageRect: DOMRect): Box[] | null {
  const { page } = match;
  const spans = new Map<number, [number, number]>();
  for (let i = match.start; i < match.end; i += 1) {
    const run = page.charItem[i];
    if (run < 0) continue;
    const offset = page.charOffset[i];
    const span = spans.get(run);
    if (!span) spans.set(run, [offset, offset + 1]);
    else span[1] = Math.max(span[1], offset + 1);
  }
  const boxes: Box[] = [];
  const range = document.createRange();
  for (const [run, [from, to]] of spans) {
    const node = nodes[run];
    if (!node || to > node.length) return null;
    range.setStart(node, from);
    range.setEnd(node, to);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({
        left: (rect.left - pageRect.left) / pageRect.width,
        top: (rect.top - pageRect.top) / pageRect.height,
        width: rect.width / pageRect.width,
        height: rect.height / pageRect.height,
      });
    }
  }
  return boxes.length > 0 ? boxes : null;
}

// Fallback when the text layer can't be measured: the index's own rects.
function estimateBoxes(match: PageTermMark): Box[] {
  const position = matchPosition(match);
  return (position?.rects ?? []).map((r) => ({
    left: r.x1 / r.width,
    top: r.y1 / r.height,
    width: (r.x2 - r.x1) / r.width,
    height: (r.y2 - r.y1) / r.height,
  }));
}

interface Hover {
  entryId: string;
  text: string;
  anchor: AnchorRect;
}

interface ViewerLike {
  container: HTMLElement;
  pagesCount: number;
  getPageView(index: number): { div?: HTMLElement } | undefined;
}

interface EventBusLike {
  on: (event: string, callback: (event: { pageNumber: number }) => void) => void;
  off: (event: string, callback: (event: { pageNumber: number }) => void) => void;
}

interface GlossaryMarksProps {
  pdfDocument: PDFDocumentProxy;
  utilsRef: RefObject<PdfHighlighterUtils | null>;
  store: GlossaryStore;
  enabled: boolean;
  onOpenInGlossary: (entryId: string) => void;
}

export default function GlossaryMarks({ pdfDocument, utilsRef, store, enabled, onOpenInGlossary }: GlossaryMarksProps) {
  const entries = useGlossaryEntries(store);
  const [index, setIndex] = useState<DocumentTextIndex | null>(null);
  const [viewer, setViewer] = useState<{ viewer: ViewerLike; bus: EventBusLike } | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const marksByPage = useRef(new Map<number, Mark[]>());
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const pendingKey = useRef<string | null>(null);
  // While the pointer is on the card, nothing hides it — including a
  // pointer move over the page that was still queued when it got there.
  const pointerOnCard = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getTextIndex(pdfDocument)
      .then((built) => {
        if (!cancelled) setIndex(built);
      })
      .catch(() => {
        // No text index, no marks — the rest of the reader is unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  // The viewer and its event bus exist only once PdfHighlighter has mounted
  // them, some time after this does.
  useEffect(() => {
    let frame = 0;
    const attach = () => {
      const utils = utilsRef.current;
      const found = utils?.getViewer() as ViewerLike | null | undefined;
      const bus = utils?.getEventBus() as EventBusLike | null | undefined;
      if (found && bus) setViewer({ viewer: found, bus });
      else frame = requestAnimationFrame(attach);
    };
    attach();
    return () => cancelAnimationFrame(frame);
  }, [utilsRef]);

  // Rebuilt only when the set of terms changes, not on every definition
  // token streamed into an entry.
  const termsSignature = entries
    .filter((entry) => entry.status !== "error")
    .map((entry) => `${entry.id}\u0000${entry.term}`)
    .join("\u0001");
  const terms = useMemo(
    () =>
      termsSignature
        .split("\u0001")
        .filter(Boolean)
        .map((pair) => {
          const [id, term] = pair.split("\u0000");
          return { id, matcher: buildTermMatcher(term) };
        })
        .filter((t): t is { id: string; matcher: TermMatcher } => t.matcher !== null),
    [termsSignature],
  );

  // Draw (or clear) each rendered page's marks, and redraw any page pdf.js
  // re-renders — a re-render (e.g. on zoom) removes the layer from the page.
  useEffect(() => {
    if (!viewer) return;
    const decorate = (pageNumber: number) => {
      const div = viewer.viewer.getPageView(pageNumber - 1)?.div;
      if (!div) return;
      let layer = div.querySelector<HTMLDivElement>(`:scope > .${LAYER_CLASS}`);
      const page = index?.pages[pageNumber - 1];
      if (!enabled || !page || terms.length === 0) {
        layer?.remove();
        marksByPage.current.delete(pageNumber);
        return;
      }
      const nodes = runTextNodes(div, page);
      const pageRect = div.getBoundingClientRect();
      const marks: Mark[] = findTermMarksOnPage(page, terms).flatMap((match) => {
        const boxes = measureBoxes(match, nodes, pageRect) ?? estimateBoxes(match);
        return boxes.length > 0 ? [{ entryId: match.id, text: page.text.slice(match.start, match.end), boxes }] : [];
      });
      marksByPage.current.set(pageNumber, marks);
      if (!layer) {
        layer = document.createElement("div");
        layer.className = LAYER_CLASS;
        layer.setAttribute("aria-hidden", "true");
        div.appendChild(layer);
      }
      layer.replaceChildren(
        ...marks.flatMap((mark) =>
          mark.boxes.map((box) => {
            const underline = document.createElement("div");
            underline.className = "glossary-mark";
            underline.style.left = `${box.left * 100}%`;
            underline.style.top = `${box.top * 100}%`;
            underline.style.width = `${box.width * 100}%`;
            underline.style.height = `${box.height * 100}%`;
            return underline;
          }),
        ),
      );
    };

    for (let pageNumber = 1; pageNumber <= viewer.viewer.pagesCount; pageNumber += 1) {
      const div = viewer.viewer.getPageView(pageNumber - 1)?.div;
      if (div?.querySelector(".textLayer") || div?.querySelector(`:scope > .${LAYER_CLASS}`)) decorate(pageNumber);
    }
    const onTextLayerRendered = (event: { pageNumber: number }) => decorate(event.pageNumber);
    viewer.bus.on("textlayerrendered", onTextLayerRendered);
    return () => viewer.bus.off("textlayerrendered", onTextLayerRendered);
  }, [viewer, index, terms, enabled]);

  // Hover: hit-test pointer moves over the viewer against the marks.
  useEffect(() => {
    if (!viewer || !enabled) return;
    const container = viewer.viewer.container;
    let frame = 0;

    const scheduleHide = () => {
      window.clearTimeout(showTimer.current);
      pendingKey.current = null;
      if (pointerOnCard.current) return;
      if (hideTimer.current === undefined) {
        hideTimer.current = window.setTimeout(() => {
          hideTimer.current = undefined;
          setHover(null);
        }, HIDE_DELAY_MS);
      }
    };

    const hitTest = (event: MouseEvent) => {
      frame = 0;
      // Not while selecting text, or while a selection (and its tip) is up.
      const selection = document.getSelection();
      if (event.buttons !== 0 || (selection && !selection.isCollapsed)) return scheduleHide();
      const pageDiv = (event.target as Element | null)?.closest<HTMLElement>(".page[data-page-number]");
      const pageNumber = Number(pageDiv?.dataset.pageNumber);
      const marks = pageDiv ? marksByPage.current.get(pageNumber) : undefined;
      if (!pageDiv || !marks) return scheduleHide();
      const pageRect = pageDiv.getBoundingClientRect();
      const x = (event.clientX - pageRect.left) / pageRect.width;
      const y = (event.clientY - pageRect.top) / pageRect.height;
      let hit: { mark: Mark; box: Box } | null = null;
      for (const mark of marks) {
        const box = mark.boxes.find((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height);
        if (box) {
          hit = { mark, box };
          break;
        }
      }
      if (!hit) return scheduleHide();

      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      const key = `${pageNumber}:${hit.box.left}:${hit.box.top}`;
      if (pendingKey.current === key) return;
      pendingKey.current = key;
      window.clearTimeout(showTimer.current);
      const { mark, box } = hit;
      showTimer.current = window.setTimeout(() => {
        const top = pageRect.top + box.top * pageRect.height;
        setHover({
          entryId: mark.entryId,
          text: mark.text,
          anchor: {
            left: pageRect.left + box.left * pageRect.width,
            top,
            bottom: top + box.height * pageRect.height,
          },
        });
      }, SHOW_DELAY_MS);
    };

    const onMove = (event: MouseEvent) => {
      if (!frame) frame = requestAnimationFrame(() => hitTest(event));
    };
    // The card is fixed-position: once the page scrolls, it no longer sits
    // over the word it belongs to.
    const onScroll = () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      pendingKey.current = null;
      setHover(null);
    };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", scheduleHide);
    container.addEventListener("scroll", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      pendingKey.current = null;
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", scheduleHide);
      container.removeEventListener("scroll", onScroll);
    };
  }, [viewer, enabled]);

  const hoveredEntry = hover ? entries.find((entry) => entry.id === hover.entryId) : undefined;
  if (!hover || !hoveredEntry || !enabled) return null;

  return createPortal(
    <GlossaryHoverCard
      entry={hoveredEntry}
      matchedText={hover.text}
      anchorRect={hover.anchor}
      onOpenInGlossary={(entryId) => {
        pointerOnCard.current = false;
        setHover(null);
        onOpenInGlossary(entryId);
      }}
      onPointerEnter={() => {
        pointerOnCard.current = true;
        window.clearTimeout(hideTimer.current);
        hideTimer.current = undefined;
      }}
      onPointerLeave={() => {
        pointerOnCard.current = false;
        window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => {
          hideTimer.current = undefined;
          pendingKey.current = null;
          setHover(null);
        }, HIDE_DELAY_MS);
      }}
    />,
    document.body,
  );
}
