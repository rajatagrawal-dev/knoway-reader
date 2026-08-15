import { useRef, useState } from "react";
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
              utilsRef={(utils) => utilsRef(utils)}
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
