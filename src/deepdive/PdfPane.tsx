import { useEffect, useRef, useState } from "react";
import {
  PdfHighlighter,
  PdfLoader,
  type GhostHighlight,
  type PdfHighlighterUtils,
  type PdfScaleValue,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import ExpandableTip from "../components/ExpandableTip";
import HighlightContainer from "../components/HighlightContainer";
import type { CommentedHighlight } from "../types";
import pdfWorkerUrl from "../pdfWorker";
import { extractPageContext } from "./pdfContext";

export type PdfSource = string | Uint8Array;

// PdfLoader invokes its children render-prop synchronously during its own
// render, so calling a state setter directly from that closure would update
// PdfPane while PdfLoader is rendering (React warns and disallows this).
// Routing the notification through this tiny component's own effect defers
// it to PdfPane's next commit instead, which is the sanctioned place to
// trigger updates in other components.
function DocumentReadySignal({
  pdfDocument,
  onDocumentReady,
}: {
  pdfDocument: PDFDocumentProxy;
  onDocumentReady?: (pdfDocument: PDFDocumentProxy) => void;
}) {
  useEffect(() => {
    onDocumentReady?.(pdfDocument);
  }, [pdfDocument, onDocumentReady]);
  return null;
}

export interface PdfPaneProps {
  source: PdfSource;
  highlights: CommentedHighlight[];
  areaMode: boolean;
  freetextMode: boolean;
  onFreetextClick: (position: ScaledPosition) => void;
  addHighlight: (
    highlight: GhostHighlight,
    comment: string,
    style?: Pick<CommentedHighlight, "highlightColor" | "highlightStyle">,
  ) => void;
  editHighlight: (id: string, edit: Partial<CommentedHighlight>) => void;
  deleteHighlight: (id: string) => void;
  utilsRef: (utils: PdfHighlighterUtils) => void;
  onOpenDive: (divePanelId: string) => void;
  onDiveDeeper: (request: { highlight: GhostHighlight; contextText: string }) => void;
  onDiveIntoExisting: (request: {
    highlightId: string;
    content: GhostHighlight["content"];
    contextText: string;
  }) => void;
  onPin: (selection: string, contextText: string) => void;
  initialPage?: number;
  onPageChange?: (pageNumber: number) => void;
  onDocumentReady?: (pdfDocument: PDFDocumentProxy) => void;
  // A highlight to scroll to precisely once this mounts (e.g. the anchor
  // point a dive annotation traces back to) — takes priority over
  // initialPage's plain page-restore when set, since it already implies the
  // right page plus the exact position on it.
  scrollToHighlightId?: string | null;
  // Controlled zoom level ("auto" for fit-width, or a fixed scale factor).
  // Must stay controlled rather than set imperatively on the viewer — see
  // App.tsx's pdfScaleValue comment for why.
  pdfScaleValue?: PdfScaleValue;
  // Fired when the user changes zoom via pinch/ctrl+wheel, so pdfScaleValue
  // can be kept in sync with gesture-driven zoom too.
  onZoomChange?: (scale: number) => void;
}

export default function PdfPane({
  source,
  highlights,
  areaMode,
  freetextMode,
  onFreetextClick,
  addHighlight,
  editHighlight,
  deleteHighlight,
  utilsRef,
  onOpenDive,
  onDiveDeeper,
  onDiveIntoExisting,
  onPin,
  initialPage,
  onPageChange,
  onDocumentReady,
  scrollToHighlightId,
  pdfScaleValue,
  onZoomChange,
}: PdfPaneProps) {
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);

  // PDF.js transfers (detaches) the Uint8Array's underlying ArrayBuffer to its
  // worker on load. PdfPane is only ever truly mounted once, on initial PDF
  // load (see PersistentPdfPane, which keeps it alive and reparents its DOM
  // instead of remounting it), so a clone is taken once here — the original
  // in App.tsx state is never touched.
  const [stableSource] = useState<PdfSource>(() =>
    source instanceof Uint8Array ? source.slice() : source,
  );

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);

  // Snapshot the page to restore only once, at PdfPane's one real mount
  // (initial PDF load — see PersistentPdfPane). `initialPage` itself
  // keeps changing after that — it's fed by `onPageChange`, which the
  // library fires on every ordinary page turn while the user scrolls — so
  // depending on the live prop here would re-arm these corrective scrolls
  // on every page change and yank the view back to a stale page mid-scroll.
  const [initialPageAtMount] = useState(initialPage);

  // Snapshot both the target id and the highlight it resolves to, once, at
  // mount — same rationale as initialPageAtMount below: scrolledToHighlightId
  // keeps changing afterward (e.g. cleared by other jumps), and reacting to
  // those later changes would yank the view around instead of only landing
  // once on whatever was requested when this pane first appeared.
  const [scrollToHighlightAtMount] = useState(() =>
    scrollToHighlightId ? (highlights.find((h) => h.id === scrollToHighlightId) ?? null) : null,
  );

  // The library's own initialPage mechanism "settles" once its internal
  // currentPageNumber counter matches the target — but that counter is set
  // synchronously inside scrollPageIntoView itself, before the actual
  // scroll (which depends on every preceding page's real, measured height)
  // has necessarily landed correctly. For a large/complex document, pages
  // far from the initially-rendered window may still have placeholder
  // height estimates when that ~2s settling window closes, so the jump can
  // land well short of the target and get reported as "done" anyway.
  // Re-issuing the same scroll command ourselves over a longer window gives
  // pdf.js time to finish measuring the intervening pages and self-correct
  // on a later call — cheap and harmless once we're already on the right
  // page, since re-scrolling to the current page is a no-op.
  useEffect(() => {
    // scrollToHighlightAtMount's own effect below already lands on (and
    // keeps correcting toward) the right page as part of scrolling to the
    // exact highlight — running this plain page-restore alongside it would
    // just fight over the scroll position on every retry tick.
    if (scrollToHighlightAtMount) return;
    if (!initialPageAtMount || initialPageAtMount <= 1) return;
    let cancelled = false;
    const timeouts = [500, 1200, 2200, 3500, 5000, 7000].map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        try {
          highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber: initialPageAtMount });
        } catch {
          // best-effort correction; nothing to do if it throws
        }
      }, delay),
    );
    return () => {
      cancelled = true;
      timeouts.forEach(window.clearTimeout);
    };
  }, [initialPageAtMount, scrollToHighlightAtMount]);

  // Same settling problem as the page-restore above, applied to scrolling
  // precisely to a highlight (e.g. the point in the main text a dive
  // annotation traces back to) instead of just its page.
  useEffect(() => {
    if (!scrollToHighlightAtMount) return;
    let cancelled = false;
    const timeouts = [500, 1200, 2200, 3500, 5000, 7000].map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        try {
          highlighterUtilsRef.current?.scrollToHighlight(scrollToHighlightAtMount);
        } catch {
          // best-effort correction; nothing to do if it throws
        }
      }, delay),
    );
    return () => {
      cancelled = true;
      timeouts.forEach(window.clearTimeout);
    };
  }, [scrollToHighlightAtMount]);

  return (
    <div className="pdf-pane-viewer">
      <PdfLoader
        document={stableSource}
        workerSrc={pdfWorkerUrl}
        beforeLoad={() => <div className="loading">Loading PDF…</div>}
      >
        {(pdfDocument) => {
          pdfDocumentRef.current = pdfDocument;
          return (
            <>
              <DocumentReadySignal pdfDocument={pdfDocument} onDocumentReady={onDocumentReady} />
              <PdfHighlighter
                pdfDocument={pdfDocument}
                highlights={highlights}
                enableAreaSelection={(event) => event.altKey || areaMode}
                areaSelectionMode={areaMode}
                enableFreetextCreation={() => freetextMode}
                onFreetextClick={onFreetextClick}
                initialPage={initialPage}
                onPageChange={onPageChange}
                pdfScaleValue={pdfScaleValue}
                onZoomChange={onZoomChange}
                selectionTip={
                  <ExpandableTip
                    addHighlight={addHighlight}
                    onDiveDeeper={async (highlight) => {
                      const contextText = await extractPageContext(
                        pdfDocumentRef.current!,
                        highlight.position.boundingRect.pageNumber,
                      );
                      onDiveDeeper({ highlight, contextText });
                    }}
                    onPin={async (selection, pageNumber) => {
                      const contextText = await extractPageContext(pdfDocumentRef.current!, pageNumber);
                      onPin(selection, contextText);
                    }}
                  />
                }
                utilsRef={(utils) => {
                  highlighterUtilsRef.current = utils;
                  utilsRef(utils);
                }}
                style={{ height: "100%" }}
              >
                <HighlightContainer
                  editHighlight={editHighlight}
                  deleteHighlight={deleteHighlight}
                  onOpenDive={onOpenDive}
                  onStartDive={async (highlightId, content, pageNumber) => {
                    const contextText = await extractPageContext(pdfDocumentRef.current!, pageNumber);
                    onDiveIntoExisting({ highlightId, content, contextText });
                  }}
                />
              </PdfHighlighter>
            </>
          );
        }}
      </PdfLoader>
    </div>
  );
}
