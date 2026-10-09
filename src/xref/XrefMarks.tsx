import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfHighlighterUtils } from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { AnchorRect } from "../deepdive/useFlippedPlacement";
import { getTextIndex } from "../text/documentText";
import { estimateBoxes, measureBoxes, runTextNodes, type Box } from "../text/pageBoxes";
import type { DocumentTextIndex } from "../glossary/textIndex";
import type { XrefRef, XrefTarget } from "./detect";
import { getXrefIndex, type XrefIndex } from "./xrefIndex";
import { XrefHoverCard, XrefPreview } from "./XrefCard";

// Cross-references in the PDF — "Eq. (3.2)", "Theorem 4.1", "[12]" — marked
// with a subtle underline. Hovering one previews what it points at; clicking
// goes there (with a way back). Built like the glossary's marks (see
// GlossaryMarks): one light layer per rendered page, hit-tested on pointer
// moves, so text selection works through it. A click on the PDF's own link
// for a reference is taken over too, so every jump is a remembered one.

const LAYER_CLASS = "xref-marks-layer";
const SHOW_DELAY_MS = 250;
const HIDE_DELAY_MS = 220;
const MAX_PINNED = 3;

interface Mark {
  ref: XrefRef;
  boxes: Box[];
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

export interface XrefBindings {
  pageLabel: (pageNumber: number) => string;
  onJump: (target: XrefTarget) => void;
  onExplain: (ref: XrefRef, target: XrefTarget) => void;
}

export default function XrefMarks({
  pdfDocument,
  utilsRef,
  bindings,
}: {
  pdfDocument: PDFDocumentProxy;
  utilsRef: RefObject<PdfHighlighterUtils | null>;
  bindings: XrefBindings;
}) {
  const [data, setData] = useState<{ index: DocumentTextIndex; xrefs: XrefIndex } | null>(null);
  const [viewer, setViewer] = useState<{ viewer: ViewerLike; bus: EventBusLike } | null>(null);
  const [hover, setHover] = useState<{ ref: XrefRef; anchor: AnchorRect } | null>(null);
  const [pinned, setPinned] = useState<XrefRef[]>([]);
  const marksByPage = useRef(new Map<number, Mark[]>());
  const showTimer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const pendingKey = useRef<string | null>(null);
  const pointerOnCard = useRef(false);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    let cancelled = false;
    Promise.all([getTextIndex(pdfDocument), getXrefIndex(pdfDocument)])
      .then(([index, xrefs]) => {
        if (!cancelled) setData({ index, xrefs });
      })
      .catch(() => {
        // No cross-references; the reader is unaffected.
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

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

  // Draw each rendered page's marks (and redraw a page pdf.js re-renders).
  useEffect(() => {
    if (!viewer || !data) return;
    const decorate = (pageNumber: number) => {
      const div = viewer.viewer.getPageView(pageNumber - 1)?.div;
      const page = data.index.pages[pageNumber - 1];
      const refs = data.xrefs.refsByPage.get(pageNumber);
      if (!div || !page) return;
      let layer = div.querySelector<HTMLDivElement>(`:scope > .${LAYER_CLASS}`);
      if (!refs?.length) {
        layer?.remove();
        marksByPage.current.delete(pageNumber);
        return;
      }
      const nodes = runTextNodes(div, page);
      const pageRect = div.getBoundingClientRect();
      const marks: Mark[] = refs.flatMap((ref) => {
        const span = { page, start: ref.start, end: ref.end };
        const boxes = measureBoxes(span, nodes, pageRect) ?? estimateBoxes(span);
        return boxes.length ? [{ ref, boxes }] : [];
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
            underline.className = "xref-mark";
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
      if (viewer.viewer.getPageView(pageNumber - 1)?.div?.querySelector(".textLayer")) decorate(pageNumber);
    }
    const onTextLayerRendered = (event: { pageNumber: number }) => decorate(event.pageNumber);
    viewer.bus.on("textlayerrendered", onTextLayerRendered);
    return () => viewer.bus.off("textlayerrendered", onTextLayerRendered);
  }, [viewer, data]);

  const hitTest = useCallback((event: MouseEvent): { mark: Mark; box: Box; pageRect: DOMRect } | null => {
    const pageDiv = (event.target as Element | null)?.closest<HTMLElement>(".page[data-page-number]");
    const marks = pageDiv ? marksByPage.current.get(Number(pageDiv.dataset.pageNumber)) : undefined;
    if (!pageDiv || !marks) return null;
    const pageRect = pageDiv.getBoundingClientRect();
    const x = (event.clientX - pageRect.left) / pageRect.width;
    const y = (event.clientY - pageRect.top) / pageRect.height;
    for (const mark of marks) {
      const box = mark.boxes.find((b) => x >= b.left && x <= b.left + b.width && y >= b.top && y <= b.top + b.height);
      if (box) return { mark, box, pageRect };
    }
    return null;
  }, []);

  // Hover to preview; click to go.
  useEffect(() => {
    if (!viewer || !data) return;
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

    const onMoveFrame = (event: MouseEvent) => {
      frame = 0;
      const selection = document.getSelection();
      if (event.buttons !== 0 || (selection && !selection.isCollapsed)) return scheduleHide();
      const hit = hitTest(event);
      if (!hit) return scheduleHide();
      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      const key = hit.mark.ref.id;
      if (pendingKey.current === key) return;
      pendingKey.current = key;
      window.clearTimeout(showTimer.current);
      const { box, pageRect, mark } = hit;
      showTimer.current = window.setTimeout(() => {
        const top = pageRect.top + box.top * pageRect.height;
        setHover({
          ref: mark.ref,
          anchor: { left: pageRect.left + box.left * pageRect.width, top, bottom: top + box.height * pageRect.height },
        });
      }, SHOW_DELAY_MS);
    };
    const onMove = (event: MouseEvent) => {
      if (!frame) frame = requestAnimationFrame(() => onMoveFrame(event));
    };

    // A plain click (not the end of a text selection) on a reference, or on
    // the PDF's own link for one, goes to its target — remembered, so Back
    // returns here.
    const onClick = (event: MouseEvent) => {
      const selection = document.getSelection();
      if (selection && !selection.isCollapsed) return;
      const link = (event.target as Element | null)?.closest<HTMLElement>("[data-annotation-id]");
      const linked = link ? data.xrefs.byAnnotation.get(link.dataset.annotationId ?? "") : undefined;
      const target = linked ?? hitTest(event)?.mark.ref.targets[0];
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      setHover(null);
      bindingsRef.current.onJump(target);
    };

    const onScroll = () => {
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      pendingKey.current = null;
      if (!pointerOnCard.current) setHover(null);
    };
    container.addEventListener("mousemove", onMove);
    container.addEventListener("mouseleave", scheduleHide);
    container.addEventListener("scroll", onScroll);
    container.addEventListener("click", onClick, true);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(showTimer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = undefined;
      pendingKey.current = null;
      container.removeEventListener("mousemove", onMove);
      container.removeEventListener("mouseleave", scheduleHide);
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("click", onClick, true);
    };
  }, [viewer, data, hitTest]);

  const preview = {
    pdfDocument,
    pageLabel: bindings.pageLabel,
    onJump: (target: XrefTarget) => {
      pointerOnCard.current = false;
      setHover(null);
      bindings.onJump(target);
    },
    onExplain: (ref: XrefRef, target: XrefTarget) => {
      pointerOnCard.current = false;
      setHover(null);
      bindings.onExplain(ref, target);
    },
  };

  return (
    <>
      {hover
        ? createPortal(
            <XrefHoverCard
              {...preview}
              xref={hover.ref}
              anchorRect={hover.anchor}
              onPin={() => {
                setPinned((list) => [...list.filter((r) => r.id !== hover.ref.id), hover.ref].slice(-MAX_PINNED));
                pointerOnCard.current = false;
                setHover(null);
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
          )
        : null}
      {pinned.length
        ? createPortal(
            <div className="xref-pinned">
              {pinned.map((ref) => (
                <div key={ref.id} className="xref-card xref-card--pinned">
                  <XrefPreview
                    {...preview}
                    xref={ref}
                    onClose={() => setPinned((list) => list.filter((r) => r.id !== ref.id))}
                  />
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
