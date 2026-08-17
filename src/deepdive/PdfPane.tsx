import { useEffect, useRef, useState } from "react";
import {
  PdfHighlighter,
  PdfLoader,
  type GhostHighlight,
  type PdfHighlighterUtils,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import ExpandableTip from "../components/ExpandableTip";
import HighlightContainer from "../components/HighlightContainer";
import type { CommentedHighlight } from "../types";
import pdfWorkerUrl from "../pdfWorker";
import { extractPageContext } from "./pdfContext";

export type PdfSource = string | Uint8Array;

export interface PdfPaneProps {
  source: PdfSource;
  highlights: CommentedHighlight[];
  areaMode: boolean;
  freetextMode: boolean;
  onFreetextClick: (position: ScaledPosition) => void;
  addHighlight: (highlight: GhostHighlight, comment: string) => void;
  editHighlight: (id: string, edit: Partial<CommentedHighlight>) => void;
  deleteHighlight: (id: string) => void;
  utilsRef: (utils: PdfHighlighterUtils) => void;
  onOpenDive: (divePanelId: string) => void;
  onDiveDeeper: (request: { highlight: GhostHighlight; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
  initialPage?: number;
  onPageChange?: (pageNumber: number) => void;
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
  onQuickMeaning,
  onPin,
  initialPage,
  onPageChange,
}: PdfPaneProps) {
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);

  // PDF.js transfers (detaches) the Uint8Array's underlying ArrayBuffer to its
  // worker on load. PdfPane remounts whenever the app switches between the
  // normal layout and the Deep Dive split view, so a clone is taken once per
  // mount here — the original in App.tsx state is never touched and stays
  // usable for the next remount.
  const [stableSource] = useState<PdfSource>(() =>
    source instanceof Uint8Array ? source.slice() : source,
  );

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);

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
    if (!initialPage || initialPage <= 1) return;
    let cancelled = false;
    const timeouts = [500, 1200, 2200, 3500, 5000, 7000].map((delay) =>
      window.setTimeout(() => {
        if (cancelled) return;
        try {
          highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber: initialPage });
        } catch {
          // best-effort correction; nothing to do if it throws
        }
      }, delay),
    );
    return () => {
      cancelled = true;
      timeouts.forEach(window.clearTimeout);
    };
  }, [initialPage]);

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
            <PdfHighlighter
              pdfDocument={pdfDocument}
              highlights={highlights}
              enableAreaSelection={(event) => event.altKey || areaMode}
              areaSelectionMode={areaMode}
              enableFreetextCreation={() => freetextMode}
              onFreetextClick={onFreetextClick}
              initialPage={initialPage}
              onPageChange={onPageChange}
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
                  onQuickMeaning={async (selection, pageNumber) => {
                    const contextText = await extractPageContext(pdfDocumentRef.current!, pageNumber);
                    return onQuickMeaning(selection, contextText);
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
              />
            </PdfHighlighter>
          );
        }}
      </PdfLoader>
    </div>
  );
}
