import { useEffect, useRef, useState } from "react";
import {
  PdfHighlighter,
  PdfLoader,
  viewportPositionToScaled,
  type GhostHighlight,
  type PdfHighlighterTheme,
  type PdfHighlighterUtils,
  type PdfScaleValue,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import ExpandableTip, { type GlossaryTipBindings } from "../components/ExpandableTip";
import HighlightContainer from "../components/HighlightContainer";
import type { CommentedHighlight } from "../types";
import pdfWorkerUrl from "../pdfWorker";
import { extractPageContext } from "./pdfContext";
import GlossaryMarks from "../glossary/GlossaryMarks";
import type { HighlightPen, Tool } from "../components/AppRail";

export type PdfSource = string | Uint8Array;

// The library paints the area around the pages with an inline style, so point
// it at CSS variables (index.css) that follow the app's light/dark theme.
// mode stays "light" on purpose: the library's dark mode would also invert
// the page content, and pages should keep their original colors.
const PDF_VIEWER_THEME: PdfHighlighterTheme = {
  mode: "light",
  containerBackgroundColor: "var(--pdf-canvas-bg)",
  scrollbarThumbColor: "var(--pdf-scrollbar)",
};

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
  // The rail's current tool (see AppRail). Highlight and Area turn a
  // finished selection straight into a highlight in `pen`'s color/style,
  // with no selection tip; Sticky note places a note on the next click.
  tool: Tool;
  pen: HighlightPen;
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
  // Whether this dive is the one currently open — see HighlightContainer.
  isDiveOpen: (divePanelId: string) => boolean;
  onDiveDeeper: (request: { highlight: GhostHighlight; contextText: string }) => void;
  onDiveIntoExisting: (request: {
    highlightId: string;
    content: GhostHighlight["content"];
    contextText: string;
  }) => void;
  onPin: (selection: string, contextText: string) => void;
  glossary: GlossaryTipBindings;
  // Dotted underlines (with hover definitions) on glossary terms in the text.
  glossaryMarks: boolean;
  // Collapses every sticky note on the page to a small comment-icon marker
  // (see the toolbar toggle in App.tsx) — threaded down to HighlightContainer,
  // which passes it on as FreetextHighlight's own `compact` prop.
  notesCollapsed: boolean;
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
  tool,
  pen,
  onFreetextClick,
  addHighlight,
  editHighlight,
  deleteHighlight,
  utilsRef,
  onOpenDive,
  isDiveOpen,
  onDiveDeeper,
  onDiveIntoExisting,
  onPin,
  glossary,
  glossaryMarks,
  notesCollapsed,
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

  const areaMode = tool === "area";
  const freetextMode = tool === "note";
  const autoHighlight = tool === "highlight" || tool === "area";

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Lets a user place a note anywhere by right-clicking, with no mode toggle
  // needed first — mirrors the click-to-place math the library itself does
  // internally for onFreetextClick (see its handleMouseDown), since that
  // conversion isn't otherwise exposed for an arbitrary point.
  const [noteContextMenu, setNoteContextMenu] = useState<{
    x: number;
    y: number;
    position: ScaledPosition;
  } | null>(null);

  useEffect(() => {
    if (!noteContextMenu) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setNoteContextMenu(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNoteContextMenu(null);
    };
    const handleScroll = () => setNoteContextMenu(null);
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    viewerContainerRef.current?.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
      viewerContainerRef.current?.removeEventListener("scroll", handleScroll, true);
    };
  }, [noteContextMenu]);

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
    <div
      className="pdf-pane-viewer"
      data-tool={tool}
      ref={viewerContainerRef}
      // In Highlight mode an existing highlight is only clickable (opening
      // its toolbar, as in any mode) — a drag starting on it must not select
      // its text again and stack a second highlight on top. Preventing the
      // mousedown default stops the text selection without affecting the
      // click (the library listens to pointer events).
      //
      // An area drag (Area mode, or Alt held) must not start a native text
      // selection either: the library flips the viewer to user-select: none
      // mid-drag, and WebKit then extends the in-progress selection across the
      // whole document, as if Cmd+A had been pressed.
      onMouseDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (
          (areaMode || event.altKey) &&
          event.button === 0 &&
          target.closest(".page") &&
          !target.closest("input, textarea, select, [contenteditable]")
        ) {
          event.preventDefault();
          window.getSelection()?.removeAllRanges();
          return;
        }
        if (tool !== "highlight") return;
        if (target.closest(".TextHighlight__part, .AreaHighlight__part")) event.preventDefault();
      }}
      onContextMenu={(event) => {
        const targetEl = event.target as HTMLElement;
        const pageEl = targetEl.closest<HTMLElement>(".page");
        const viewer = highlighterUtilsRef.current?.getViewer();
        if (!pageEl || !viewer) return;
        const pageNumberAttr = pageEl.getAttribute("data-page-number");
        const pageNumber = pageNumberAttr ? Number(pageNumberAttr) : NaN;
        if (!Number.isFinite(pageNumber)) return;
        event.preventDefault();
        const pageRect = pageEl.getBoundingClientRect();
        const scaledPosition = viewportPositionToScaled(
          {
            boundingRect: {
              left: event.clientX - pageRect.left,
              top: event.clientY - pageRect.top,
              width: 150,
              height: 80,
              pageNumber,
            },
            rects: [],
          },
          viewer,
        );
        setNoteContextMenu({ x: event.clientX, y: event.clientY, position: scaledPosition });
      }}
    >
      {noteContextMenu ? (
        <div
          ref={contextMenuRef}
          className="pdf-context-menu"
          style={{ top: noteContextMenu.y, left: noteContextMenu.x }}
        >
          <button
            type="button"
            className="pdf-context-menu-item"
            onClick={() => {
              onFreetextClick(noteContextMenu.position);
              setNoteContextMenu(null);
            }}
          >
            Add note here
          </button>
        </div>
      ) : null}
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
              <GlossaryMarks
                pdfDocument={pdfDocument}
                utilsRef={highlighterUtilsRef}
                store={glossary.store}
                enabled={glossaryMarks}
                onOpenInGlossary={glossary.onOpenInGlossary}
              />
              <PdfHighlighter
                pdfDocument={pdfDocument}
                theme={PDF_VIEWER_THEME}
                highlights={highlights}
                enableAreaSelection={(event) => event.altKey || areaMode}
                areaSelectionMode={areaMode}
                enableFreetextCreation={() => freetextMode}
                onFreetextClick={onFreetextClick}
                initialPage={initialPage}
                onPageChange={onPageChange}
                pdfScaleValue={pdfScaleValue}
                onZoomChange={onZoomChange}
                onSelection={(selection) => {
                  if (!autoHighlight) return;
                  if (selection.type !== "area" && !selection.content.text?.trim()) return;
                  const style =
                    selection.type === "area"
                      ? { highlightColor: pen.color }
                      : { highlightColor: pen.color, highlightStyle: pen.style };
                  // Same sequence as the selection tip's own finalize (see
                  // ExpandableTip): makeGhostHighlight clears the selection,
                  // removeGhostHighlight ends the library's editing state.
                  addHighlight(selection.makeGhostHighlight(), "", style);
                  highlighterUtilsRef.current?.removeGhostHighlight();
                }}
                selectionTip={
                  autoHighlight ? undefined : (
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
                      glossary={glossary}
                    />
                  )
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
                  notesCollapsed={notesCollapsed}
                  onOpenDive={onOpenDive}
                  isDiveOpen={isDiveOpen}
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
