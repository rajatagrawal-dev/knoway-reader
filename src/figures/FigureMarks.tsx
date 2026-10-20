import { useEffect, useRef, useState, type RefObject } from "react";
import type { PdfHighlighterUtils, PdfSelection } from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { FigureRegion } from "./detect";
import { getPageFigures } from "./figureIndex";

// Figures in the PDF — pictures, plots, diagrams — outlined on hover and
// selected with a click, as if their area had been dragged out (Alt-drag):
// the selection tip opens for it, or, with the Area tool, it's highlighted
// straight away. Built like the cross-reference marks (see XrefMarks): one
// layer per rendered page that ignores the pointer, hit-tested on pointer
// moves, so text selection works through it.

const LAYER_CLASS = "figure-marks-layer";
const HOVER_CLASS = "is-hover";
const ACTIVE_CLASS = "is-active";
const CONTAINER_HOVER_CLASS = "figure-hover";
const CLICK_SLOP = 4; // px the pointer may move and still be a click, not a drag
const MAX_IMAGE_SIDE = 1600;

// Clicks on these are theirs, not the figure's under them.
const OWN_CLICKS =
  ".PdfHighlighter__tip-container, .TextHighlight, .AreaHighlight, .FreetextHighlight, .ImageHighlight, " +
  ".DrawingHighlight, .ShapeHighlight, .highlight-anchor, a, button, input, textarea, [contenteditable], [data-annotation-id]";

interface PageViewLike {
  div?: HTMLElement;
  canvas?: HTMLCanvasElement;
  viewport: { width: number; height: number };
}

interface ViewerLike {
  container: HTMLElement;
  pagesCount: number;
  getPageView(index: number): PageViewLike | undefined;
}

interface EventBusLike {
  on: (event: string, callback: (event: { pageNumber: number }) => void) => void;
  off: (event: string, callback: (event: { pageNumber: number }) => void) => void;
}

interface Hit {
  pageNumber: number;
  index: number;
  figure: FigureRegion;
  mark: HTMLElement | undefined;
}

// The figure as the page draws it now, cut from the page's own canvas —
// at the canvas's resolution (sharper than the area tool's CSS-pixel
// screenshot, so small axis labels stay legible), within a sensible size.
function screenshot(pageView: PageViewLike, figure: FigureRegion): string | null {
  const canvas = pageView.canvas;
  if (!canvas || !canvas.width || !canvas.height) return null;
  const sx = Math.round(figure.left * canvas.width);
  const sy = Math.round(figure.top * canvas.height);
  const sw = Math.max(1, Math.round(figure.width * canvas.width));
  const sh = Math.max(1, Math.round(figure.height * canvas.height));
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(sw * scale));
  out.height = Math.max(1, Math.round(sh * scale));
  const context = out.getContext("2d");
  if (!context) return null;
  context.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

export default function FigureMarks({
  pdfDocument,
  utilsRef,
  enabled,
  pointer,
}: {
  pdfDocument: PDFDocumentProxy;
  utilsRef: RefObject<PdfHighlighterUtils | null>;
  // Whether a click selects the figure (off while another tool is in use).
  enabled: boolean;
  // Whether hovering shows the pointer cursor (the Area tool keeps its
  // crosshair).
  pointer: boolean;
}) {
  const [viewer, setViewer] = useState<{ viewer: ViewerLike; bus: EventBusLike } | null>(null);
  const figuresByPage = useRef(new Map<number, FigureRegion[]>());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const pointerRef = useRef(pointer);
  pointerRef.current = pointer;

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

  // Outline each rendered page's figures (and again when pdf.js re-renders
  // a page, which replaces its layers).
  useEffect(() => {
    if (!viewer) return;
    let cancelled = false;
    const decorate = (pageNumber: number) => {
      void getPageFigures(pdfDocument, pageNumber).then((figures) => {
        const div = viewer.viewer.getPageView(pageNumber - 1)?.div;
        if (cancelled || !div) return;
        figuresByPage.current.set(pageNumber, figures);
        let layer = div.querySelector<HTMLDivElement>(`:scope > .${LAYER_CLASS}`);
        if (!figures.length) {
          layer?.remove();
          return;
        }
        if (!layer) {
          layer = document.createElement("div");
          layer.className = LAYER_CLASS;
          layer.setAttribute("aria-hidden", "true");
          div.appendChild(layer);
        }
        layer.replaceChildren(
          ...figures.map((figure) => {
            const mark = document.createElement("div");
            mark.className = "figure-mark";
            mark.style.left = `${figure.left * 100}%`;
            mark.style.top = `${figure.top * 100}%`;
            mark.style.width = `${figure.width * 100}%`;
            mark.style.height = `${figure.height * 100}%`;
            return mark;
          }),
        );
      });
    };
    for (let pageNumber = 1; pageNumber <= viewer.viewer.pagesCount; pageNumber += 1) {
      if (viewer.viewer.getPageView(pageNumber - 1)?.div?.querySelector(".textLayer")) decorate(pageNumber);
    }
    const onTextLayerRendered = (event: { pageNumber: number }) => decorate(event.pageNumber);
    viewer.bus.on("textlayerrendered", onTextLayerRendered);
    return () => {
      cancelled = true;
      viewer.bus.off("textlayerrendered", onTextLayerRendered);
    };
  }, [viewer, pdfDocument]);

  // Hover to outline; click to select.
  useEffect(() => {
    if (!viewer) return;
    const container = viewer.viewer.container;
    let frame = 0;
    let hovered: HTMLElement | undefined;
    let active: { mark: HTMLElement | undefined; selection: PdfSelection } | null = null;
    let down: { x: number; y: number } | null = null;

    const hitTest = (event: MouseEvent): Hit | null => {
      const target = event.target as Element | null;
      if (!target || target.closest(OWN_CLICKS)) return null;
      const pageDiv = target.closest<HTMLElement>(".page[data-page-number]");
      const pageNumber = Number(pageDiv?.dataset.pageNumber);
      const figures = figuresByPage.current.get(pageNumber);
      if (!pageDiv || !figures?.length) return null;
      const pageRect = pageDiv.getBoundingClientRect();
      const x = (event.clientX - pageRect.left) / pageRect.width;
      const y = (event.clientY - pageRect.top) / pageRect.height;
      // The smallest figure under the pointer, should two overlap.
      let best: { index: number; figure: FigureRegion } | null = null;
      for (const [index, figure] of figures.entries()) {
        if (x < figure.left || x > figure.left + figure.width || y < figure.top || y > figure.top + figure.height) continue;
        if (best && best.figure.width * best.figure.height <= figure.width * figure.height) continue;
        best = { index, figure };
      }
      if (!best) return null;
      const mark = pageDiv.querySelectorAll<HTMLElement>(`:scope > .${LAYER_CLASS} > .figure-mark`)[best.index];
      return { pageNumber, ...best, mark };
    };

    const setHovered = (mark: HTMLElement | undefined) => {
      if (mark === hovered) return;
      hovered?.classList.remove(HOVER_CLASS);
      mark?.classList.add(HOVER_CLASS);
      hovered = mark;
      container.classList.toggle(CONTAINER_HOVER_CLASS, Boolean(mark) && pointerRef.current);
    };

    const setActive = (next: typeof active) => {
      active?.mark?.classList.remove(ACTIVE_CLASS);
      next?.mark?.classList.add(ACTIVE_CLASS);
      active = next;
    };

    const onMoveFrame = (event: MouseEvent) => {
      frame = 0;
      const selection = document.getSelection();
      const busy = event.buttons !== 0 || (selection && !selection.isCollapsed);
      setHovered(enabledRef.current && !busy ? hitTest(event)?.mark : undefined);
    };
    const onMove = (event: MouseEvent) => {
      if (!frame) frame = requestAnimationFrame(() => onMoveFrame(event));
    };
    const onLeave = () => setHovered(undefined);

    const onPointerDown = (event: PointerEvent) => {
      down = { x: event.clientX, y: event.clientY };
    };

    const onClick = (event: MouseEvent) => {
      const start = down;
      down = null;
      if (!enabledRef.current || event.button !== 0) return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) return; // the end of a text selection
      const hit = hitTest(event);
      const utils = utilsRef.current;
      const pageView = viewer.viewer.getPageView(hit ? hit.pageNumber - 1 : -1);
      if (!hit || !utils || !pageView) return;
      const image = screenshot(pageView, hit.figure);
      if (!image) return;
      const { width, height } = pageView.viewport;
      const selected = utils.setAreaSelection(
        {
          boundingRect: {
            left: hit.figure.left * width,
            top: hit.figure.top * height,
            width: hit.figure.width * width,
            height: hit.figure.height * height,
            pageNumber: hit.pageNumber,
          },
          rects: [],
        },
        image,
      );
      // With the Area tool the selection is already a highlight by now.
      setActive(selected && utils.getCurrentSelection() === selected ? { mark: hit.mark, selection: selected } : null);
    };

    // The outline stays while its selection does: until the tip turns it
    // into something, or a click elsewhere or Escape dismisses it.
    const onDismiss = () => {
      if (!active) return;
      window.setTimeout(() => {
        if (active && utilsRef.current?.getCurrentSelection() !== active.selection) setActive(null);
      }, 0);
    };

    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", onLeave);
    container.addEventListener("pointerdown", onPointerDown, true);
    container.addEventListener("click", onClick);
    document.addEventListener("pointerdown", onDismiss);
    document.addEventListener("click", onDismiss);
    document.addEventListener("keydown", onDismiss);
    return () => {
      cancelAnimationFrame(frame);
      setHovered(undefined);
      setActive(null);
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", onLeave);
      container.removeEventListener("pointerdown", onPointerDown, true);
      container.removeEventListener("click", onClick);
      document.removeEventListener("pointerdown", onDismiss);
      document.removeEventListener("click", onDismiss);
      document.removeEventListener("keydown", onDismiss);
    };
  }, [viewer, utilsRef]);

  return null;
}
