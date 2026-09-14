import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  exportPdf,
  type GhostHighlight,
  type PdfHighlighterUtils,
  type PdfScaleValue,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
// react-pdf-highlighter-plus only ships *overrides* on top of PDF.js's own
// viewer stylesheet (see its style/pdf_viewer.css header comment). Without
// the base stylesheet, the text layer spans lack `position: absolute` and
// text selection over the PDF is broken.
import "pdfjs-dist/web/pdf_viewer.css";
import "react-pdf-highlighter-plus/style/style.css";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { SpreadMode } from "pdfjs-dist/web/pdf_viewer.mjs";
import { Columns2, Rows3, ZoomIn, ZoomOut } from "lucide-react";
import Sidebar, { type SidebarPanel } from "./components/Sidebar";
import SearchBar, { SearchToggleButton } from "./components/SearchBar";
import type { CommentedHighlight } from "./types";
import "./App.css";
import PersistentPdfPane from "./deepdive/PersistentPdfPane";
import DeepDiveView from "./deepdive/DeepDiveView";
import type { DiveHighlight, DivePanel, Pin } from "./deepdive/types";
import {
  ancestorChain,
  appendTurn,
  createNestedPanel,
  createRootPanel,
  paneWindow,
  panelById,
  panelSubtreeIds,
  replacePanel,
  rootPanelOf,
} from "./deepdive/tree";
import {
  diveHighlightsKeyForFile,
  divesKeyForFile,
  loadDiveHighlights,
  loadDivePanels,
  loadPins,
  pinsKeyForFile,
  saveDiveHighlights,
  saveDivePanels,
  savePins,
} from "./deepdive/store";
import { buildDiveSystem, openingMessage } from "./deepdive/prompts";
import { streamDiveReply } from "./deepdive/api";
import { parseDataUrlImage } from "./deepdive/image";

type PdfSource = string | Uint8Array;

interface LoadedPdf {
  source: PdfSource;
  fileName: string;
  storageKey: string;
  divesKey: string;
  pinsKey: string;
  diveHighlightsKey: string;
}

const getNextId = () => crypto.randomUUID();

// Top/bottom of one page's element, in the scroll container's own
// scrollTop coordinate space (i.e. offset-from-document-start, not
// viewport-relative) — used to keep wheel-driven paging from skipping over
// the rest of a page that's taller than the viewport (see the wheel
// listener below).
function getPageVerticalBounds(container: HTMLElement, pageNumber: number) {
  const pageEl = container.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
  if (!pageEl) return null;
  const top =
    pageEl.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
  return { top, bottom: top + pageEl.offsetHeight };
}

const MIN_ZOOM_SCALE = 0.25;
const MAX_ZOOM_SCALE = 5;
const ZOOM_STEP_FACTOR = 1.2;

function storageKeyForFile(file: File): string {
  return `pdf-highlights:${file.name}:${file.size}:${file.lastModified}`;
}

function loadHighlights(key: string): CommentedHighlight[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as CommentedHighlight[];
  } catch {
    return [];
  }
}

function saveHighlights(key: string, highlights: CommentedHighlight[]) {
  localStorage.setItem(key, JSON.stringify(highlights));
}

function UploadScreen({ onFileSelected }: { onFileSelected: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <h1>MuseReader</h1>
        <p>
          Upload a PDF to view it, highlight text, add comments, and place sticky
          notes.
        </p>
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose PDF file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) onFileSelected(file);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const [highlights, setHighlights] = useState<CommentedHighlight[]>([]);
  const [panels, setPanels] = useState<DivePanel[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [diveHighlights, setDiveHighlights] = useState<DiveHighlight[]>([]);
  const [diveFocusId, setDiveFocusId] = useState<string | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [freetextMode, setFreetextMode] = useState(false);
  const [scrolledToHighlightId, setScrolledToHighlightId] = useState<string | null>(
    null,
  );
  const [scrolledToDiveHighlightId, setScrolledToDiveHighlightId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // `initialPage` seeds PdfPane's one-time mount-restore effects (see
  // PdfPane.tsx) for the single real mount that happens on PDF load; it's
  // otherwise just kept in sync with the live page for other consumers
  // (Sidebar's page display, goToPage, etc).
  const [currentPage, setCurrentPage] = useState(1);
  const [activeSidebarPanel, setActiveSidebarPanel] = useState<SidebarPanel | null>(
    "toc",
  );
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageLabels, setPageLabels] = useState<string[] | null>(null);
  // Left as "auto" (fit-width) until the user's first manual zoom action, at
  // which point it becomes a fixed numeric scale — same behavior as Adobe
  // Reader. This has to be a controlled prop fed to PdfHighlighter (not just
  // an imperative `viewer.currentScaleValue` write) because the library's own
  // ResizeObserver periodically re-applies this exact value to the viewer
  // (see `handleScaleValue` in its source); leaving it at the default "auto"
  // while zooming imperatively caused the ResizeObserver to silently snap the
  // zoom back to fit-width on the very next resize tick.
  const [pdfScaleValue, setPdfScaleValue] = useState<PdfScaleValue>("auto");
  // Non-null while the zoom readout is being edited as text; holds the raw
  // (possibly invalid/in-progress) input value until it's committed.
  const [zoomEditValue, setZoomEditValue] = useState<string | null>(null);
  const [twoPageView, setTwoPageView] = useState(false);
  const [continuousScroll, setContinuousScroll] = useState(true);

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelsRef = useRef<DivePanel[]>([]);
  const workspaceSlotRef = useRef<HTMLDivElement | null>(null);
  const deepDiveRootSlotRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    if (!pdfDocument) {
      setPageLabels(null);
      return;
    }
    let cancelled = false;
    pdfDocument
      .getPageLabels()
      .then((labels) => {
        if (!cancelled) setPageLabels(labels);
      })
      .catch(() => {
        if (!cancelled) setPageLabels(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  useEffect(() => {
    if (!loadedPdf) return;
    saveHighlights(loadedPdf.storageKey, highlights);
  }, [highlights, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    saveDivePanels(loadedPdf.divesKey, panels);
  }, [panels, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    savePins(loadedPdf.pinsKey, pins);
  }, [pins, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    saveDiveHighlights(loadedPdf.diveHighlightsKey, diveHighlights);
  }, [diveHighlights, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadedPdf]);

  // "Continuous scrolling off" means the viewer never free-scrolls *between*
  // pages — but it still has to scroll *within* one, since at higher zoom
  // levels a page is taller than the viewport. Rather than lean on pdf.js's
  // own PAGE scroll mode (which only constrains layout — the
  // wheel-to-page-turn behavior lives in pdf.js's full app shell, not the
  // bare PDFViewer this library wraps), a wheel listener manually advances
  // `container.scrollTop`, clamped to the current page's own top/bottom
  // bounds. Only once a wheel event would cross that boundary (nothing more
  // of the current page left to reveal) does it turn to the next/previous
  // page instead of scrolling — so the rest of a zoomed-in page is always
  // reachable before the page turns. `nextPage`/`previousPage` already
  // account for two-page spread mode (advancing by 2 there), so this
  // composes with the page-layout toggle for free.
  useEffect(() => {
    if (continuousScroll) return;
    const viewer = highlighterUtilsRef.current?.getViewer();
    const container = viewer?.container;
    if (!viewer || !container) return;

    const BOUNDARY_EPSILON = 1;
    // A single scroll gesture (mouse wheel notch or trackpad swipe) fires
    // many wheel events in quick succession; once one of them turns a page,
    // further events are ignored until this cooldown elapses, so the same
    // gesture doesn't also turn the next page.
    let cooldownTimeout: number | null = null;
    const handleWheel = (event: WheelEvent) => {
      const delta = event.deltaY;
      if (delta === 0) return;
      event.preventDefault();

      const bounds = getPageVerticalBounds(container, viewer.currentPageNumber);
      if (delta > 0) {
        const maxScrollTop = bounds ? bounds.bottom - container.clientHeight : -Infinity;
        if (container.scrollTop < maxScrollTop - BOUNDARY_EPSILON) {
          container.scrollTop = Math.min(container.scrollTop + delta, maxScrollTop);
          return;
        }
      } else {
        const minScrollTop = bounds ? bounds.top : Infinity;
        if (container.scrollTop > minScrollTop + BOUNDARY_EPSILON) {
          container.scrollTop = Math.max(container.scrollTop + delta, minScrollTop);
          return;
        }
      }

      if (cooldownTimeout !== null) return;
      if (delta > 0) {
        viewer.nextPage();
      } else {
        // previousPage() lands scrollTop at the new page's *top* (pdf.js has
        // no notion of "enter from below") — but scrolling up into a page
        // should arrive at its bottom, mirroring how scrolling down arrives
        // at the next page's top, so reversing direction retraces the same
        // ground instead of skipping the whole previous page.
        viewer.previousPage();
        const enteredBounds = getPageVerticalBounds(container, viewer.currentPageNumber);
        if (enteredBounds) {
          container.scrollTop = Math.max(
            enteredBounds.top,
            enteredBounds.bottom - container.clientHeight,
          );
        }
      }
      cooldownTimeout = window.setTimeout(() => {
        cooldownTimeout = null;
      }, 500);
    };
    container.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", handleWheel);
      if (cooldownTimeout !== null) window.clearTimeout(cooldownTimeout);
    };
  }, [continuousScroll, pdfDocument]);

  // Same "no partial movement" rule extended to the keyboard: with
  // continuous scrolling off, arrow keys turn a whole page instead of
  // nudging the scroll position. Ignored while a modifier key is held (so
  // browser/OS shortcuts still work) or while typing in an editable field
  // (search box, comment box, dive composer, etc).
  useEffect(() => {
    if (continuousScroll) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const viewer = highlighterUtilsRef.current?.getViewer();
      if (!viewer) return;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        viewer.nextPage();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        viewer.previousPage();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [continuousScroll]);

  const loadPdfFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const arrayBuffer = event.target?.result;
      if (!(arrayBuffer instanceof ArrayBuffer)) return;

      const storageKey = storageKeyForFile(file);
      const divesKey = divesKeyForFile(file);
      const pinsKey = pinsKeyForFile(file);
      const diveHighlightsKey = diveHighlightsKeyForFile(file);
      setLoadedPdf({
        source: new Uint8Array(arrayBuffer),
        fileName: file.name,
        storageKey,
        divesKey,
        pinsKey,
        diveHighlightsKey,
      });
      setHighlights(loadHighlights(storageKey));
      setPanels(loadDivePanels(divesKey));
      setPins(loadPins(pinsKey));
      setDiveHighlights(loadDiveHighlights(diveHighlightsKey));
      setAreaMode(false);
      setFreetextMode(false);
      setDiveFocusId(null);
      setCurrentPage(1);
      setPdfDocument(null);
    };
    reader.onerror = () => {
      alert("Failed to read the PDF file.");
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const addHighlight = (
    highlight: GhostHighlight,
    comment: string,
    style?: Pick<CommentedHighlight, "highlightColor" | "highlightStyle">,
  ) => {
    const next: CommentedHighlight = {
      ...highlight,
      ...style,
      id: getNextId(),
      comment,
    };
    setHighlights((previous) => [next, ...previous]);
    if (areaMode) setAreaMode(false);
  };

  const editHighlight = (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => {
    setHighlights((previous) =>
      previous.map((highlight) =>
        highlight.id === idToUpdate ? { ...highlight, ...edit } : highlight,
      ),
    );
  };

  // Cascade-deletes a dive panel and every panel nested beneath it, along
  // with the dive highlights placed inside any of them — an annotation's
  // dive branch is part of that annotation, not independent of it, so
  // deleting the annotation takes the whole branch with it rather than
  // leaving orphaned panels/highlights behind. If the panel currently being
  // viewed is inside what's being removed, focus falls back to
  // `fallbackFocusId` (the panel that anchored the deleted branch, or null
  // for the main workspace) so the view doesn't keep pointing at deleted
  // content.
  const deletePanelSubtree = useCallback((panelId: string, fallbackFocusId: string | null) => {
    const idsToDelete = panelSubtreeIds(panelsRef.current, panelId);
    setPanels((previous) => previous.filter((panel) => !idsToDelete.has(panel.id)));
    setDiveHighlights((previous) => previous.filter((highlight) => !idsToDelete.has(highlight.panelId)));
    setDiveFocusId((current) => (current && idsToDelete.has(current) ? fallbackFocusId : current));
  }, []);

  const deleteHighlight = (highlightId: string) => {
    const highlight = highlights.find((h) => h.id === highlightId);
    setHighlights((previous) =>
      previous.filter((highlight) => highlight.id !== highlightId),
    );
    if (highlight?.divePanelId) deletePanelSubtree(highlight.divePanelId, null);
  };

  const handleFreetextClick = (position: ScaledPosition) => {
    const next: CommentedHighlight = {
      id: getNextId(),
      type: "freetext",
      position,
      content: { text: "New note" },
    };
    setHighlights((previous) => [next, ...previous]);
    setFreetextMode(false);
  };

  const handleExport = async () => {
    if (!loadedPdf) return;
    setExporting(true);
    try {
      const pdfBytes = await exportPdf(loadedPdf.source, highlights);
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = loadedPdf.fileName.replace(/\.pdf$/i, "") + "-annotated.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      alert("Failed to export PDF. See console for details.");
    } finally {
      setExporting(false);
    }
  };

  const jumpToHighlight = (highlight: CommentedHighlight) => {
    setScrolledToHighlightId(highlight.id);
    highlighterUtilsRef.current?.scrollToHighlight(highlight);
  };

  const goToPage = (pageNumber: number) => {
    highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber });
  };

  const applyZoom = (factor: number) => {
    const currentNumericScale =
      typeof pdfScaleValue === "number"
        ? pdfScaleValue
        : (highlighterUtilsRef.current?.getViewer()?.currentScale ?? 1);
    setPdfScaleValue(
      Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, currentNumericScale * factor)),
    );
  };

  const zoomIn = () => applyZoom(ZOOM_STEP_FACTOR);
  const zoomOut = () => applyZoom(1 / ZOOM_STEP_FACTOR);

  const startEditingZoom = () => {
    const currentPercent =
      typeof pdfScaleValue === "number"
        ? Math.round(pdfScaleValue * 100)
        : Math.round((highlighterUtilsRef.current?.getViewer()?.currentScale ?? 1) * 100);
    setZoomEditValue(String(currentPercent));
  };

  const commitZoomEdit = () => {
    const parsed = zoomEditValue === null ? NaN : Number.parseFloat(zoomEditValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      setPdfScaleValue(Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, parsed / 100)));
    }
    setZoomEditValue(null);
  };

  const toggleTwoPageView = () => {
    const next = !twoPageView;
    setTwoPageView(next);
    const viewer = highlighterUtilsRef.current?.getViewer();
    if (viewer) viewer.spreadMode = next ? SpreadMode.ODD : SpreadMode.NONE;
  };

  const toggleContinuousScroll = () => setContinuousScroll((value) => !value);

  const handleSelectSidebarPanel = (panel: SidebarPanel) => {
    setActiveSidebarPanel((current) => (current === panel ? null : panel));
  };

  // Appends the user turn, builds the system prompt from the panel's own
  // context (+ its parent's selection, one sentence, per spec §6), streams
  // the reply, and appends the assistant turn once done. A failure appends
  // an inline "⚠️" turn instead of throwing, so the composer never crashes
  // (spec §9).
  const sendDiveMessage = useCallback(
    async (panelId: string, content: string, onChunk?: (chunk: string) => void) => {
      if (!loadedPdf) return;
      const panel = panelById(panelsRef.current, panelId);
      if (!panel) return;
      const parentPanel = panel.parentId ? panelById(panelsRef.current, panel.parentId) : null;

      const withUserTurn = appendTurn(panel, "user", content);
      setPanels((prev) => replacePanel(prev, withUserTurn));

      const system = buildDiveSystem(loadedPdf.fileName, withUserTurn, parentPanel);
      // The backend is stateless (a fresh CLI process per request, no
      // persisted session), so every call rebuilds the full turn history —
      // an area-highlight's screenshot has to be resent on every follow-up,
      // attached to the first turn, for the model to keep the visual context.
      const messages = withUserTurn.turns.map((turn, index) => ({
        role: turn.role,
        content: turn.content,
        ...(index === 0 && panel.selectionImage ? { image: panel.selectionImage } : {}),
      }));

      try {
        const full = await streamDiveReply({ system, messages, onText: (chunk) => onChunk?.(chunk) });
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          return replacePanel(prev, appendTurn(latest, "assistant", full));
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Dive reply failed.";
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          return replacePanel(prev, appendTurn(latest, "assistant", `⚠️ ${message}`));
        });
      }
    },
    [loadedPdf],
  );

  const createAndOpenDive = useCallback(
    (panel: DivePanel) => {
      // panelsRef is updated synchronously (not via the panels-syncing effect,
      // which hasn't run yet) so the immediate sendDiveMessage call below can
      // find this panel — it looks the panel up through the ref, not state.
      panelsRef.current = [...panelsRef.current, panel];
      setPanels(panelsRef.current);
      setDiveFocusId(panel.id);
      void sendDiveMessage(panel.id, openingMessage(panel.selection));
    },
    [sendDiveMessage],
  );

  const handleDiveDeeper = useCallback(
    ({ highlight, contextText }: { highlight: GhostHighlight; contextText: string }) => {
      const text = highlight.content.text;
      const selectionImage = parseDataUrlImage(highlight.content.image);
      if (!text && !selectionImage) return;
      const highlightId = getNextId();
      const panel = createRootPanel({
        anchorHighlightId: highlightId,
        selection: text ?? "",
        contextText,
        selectionImage,
      });
      const next: CommentedHighlight = {
        ...highlight,
        id: highlightId,
        comment: "",
        divePanelId: panel.id,
      };
      setHighlights((previous) => [next, ...previous]);
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleDiveIntoExisting = useCallback(
    ({
      highlightId,
      content,
      contextText,
    }: {
      highlightId: string;
      content: GhostHighlight["content"];
      contextText: string;
    }) => {
      const text = content.text;
      const selectionImage = parseDataUrlImage(content.image);
      if (!text && !selectionImage) return;
      const panel = createRootPanel({
        anchorHighlightId: highlightId,
        selection: text ?? "",
        contextText,
        selectionImage,
      });
      editHighlight(highlightId, { divePanelId: panel.id });
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleNestedDive = useCallback(
    ({ parentId, selection, contextText }: { parentId: string; selection: string; contextText: string }) => {
      const panel = createNestedPanel({ parentId, selection, contextText });
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handlePin = useCallback((text: string, context: string) => {
    setPins((previous) => [
      { id: getNextId(), text, context, createdAt: new Date().toISOString() },
      ...previous,
    ]);
  }, []);

  const handleAddDiveHighlight = useCallback(
    (
      panelId: string,
      text: string,
      comment: string,
      style?: Pick<DiveHighlight, "highlightColor" | "highlightStyle">,
    ) => {
      setDiveHighlights((previous) => [
        { id: getNextId(), panelId, text, comment, ...style, createdAt: new Date().toISOString() },
        ...previous,
      ]);
    },
    [],
  );

  const handleEditDiveHighlight = useCallback(
    (
      highlightId: string,
      edit: Partial<Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "comment" | "divePanelId">>,
    ) => {
      setDiveHighlights((previous) =>
        previous.map((highlight) => (highlight.id === highlightId ? { ...highlight, ...edit } : highlight)),
      );
    },
    [],
  );

  const handleDeleteDiveHighlight = useCallback(
    (highlightId: string) => {
      const highlight = diveHighlights.find((h) => h.id === highlightId);
      setDiveHighlights((previous) => previous.filter((h) => h.id !== highlightId));
      if (highlight?.divePanelId) deletePanelSubtree(highlight.divePanelId, highlight.panelId);
    },
    [diveHighlights, deletePanelSubtree],
  );

  // "Dive deeper" from an already-placed dive highlight (its edit toolbar's
  // Dive control) rather than a fresh selection: reopens the nested dive it
  // already started, or starts one and remembers it on the highlight so the
  // next click reopens it instead of branching again.
  const handleDiveFromDiveHighlight = useCallback(
    (highlight: DiveHighlight, contextText: string) => {
      if (highlight.divePanelId) {
        setDiveFocusId(highlight.divePanelId);
        return;
      }
      const panel = createNestedPanel({ parentId: highlight.panelId, selection: highlight.text, contextText });
      setDiveHighlights((previous) =>
        previous.map((h) => (h.id === highlight.id ? { ...h, divePanelId: panel.id } : h)),
      );
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleDeletePin = (pinId: string) => {
    setPins((previous) => previous.filter((pin) => pin.id !== pinId));
  };

  const handleOpenDive = (divePanelId: string) => {
    setDiveFocusId(divePanelId);
  };

  // From the annotations panel's "Dive ↗" badge: the highlight it fires from
  // lives in the main text (unlike handleOpenDiveHighlight's dive-note case),
  // so its own page is the jump target — no root/anchor tracing needed. Also
  // moves the main PDF there explicitly (see handleOpenDiveHighlight's
  // comment above for why an instant jump, not scrollToHighlight, is used).
  const handleOpenDiveFromHighlight = (highlight: CommentedHighlight) => {
    if (!highlight.divePanelId) return;
    setDiveFocusId(highlight.divePanelId);
    setScrolledToHighlightId(highlight.id);
    setCurrentPage(highlight.position.boundingRect.pageNumber);
    highlighterUtilsRef.current
      ?.getViewer()
      ?.scrollPageIntoView({ pageNumber: highlight.position.boundingRect.pageNumber });
  };

  // From the annotations panel: focus the dive that contains this note and
  // scroll it into view there (see the scroll effect in DivePanelPane), and
  // also move the main PDF to this dive branch's starting point — every
  // dive, however deeply nested, traces back through its parentId chain to
  // one root panel anchored on a highlight in the main text. PdfPane is
  // always mounted (see PersistentPdfPane), so this takes effect immediately
  // even when the main pane isn't part of the current split view (paneWindow
  // only shows the last two panes) — currentPage is still set alongside it
  // as the source of truth for other consumers (Sidebar's page display,
  // goToPage).
  //
  // Uses the viewer's own (instant) scrollPageIntoView rather than
  // scrollToHighlight: setting diveFocusId in the same tick reparents the
  // main pane (see PersistentPdfPane), whose own layout effect captures
  // "current page" for scroll preservation across that move. scrollToHighlight
  // animates with behavior: "smooth", so at the moment that effect reads the
  // page it's barely left the old one — the capture locks in the wrong page,
  // and PersistentPdfPane's correction timers spend the next several seconds
  // fighting our jump back to it. The instant jump lands (and updates the
  // viewer's currentPageNumber) synchronously, before that effect runs, so it
  // captures the right page instead.
  const handleOpenDiveHighlight = useCallback(
    (highlight: DiveHighlight) => {
      setDiveFocusId(highlight.panelId);
      setScrolledToDiveHighlightId(highlight.id);

      const root = rootPanelOf(panelsRef.current, highlight.panelId);
      const anchorHighlight = root?.anchorHighlightId
        ? highlights.find((h) => h.id === root.anchorHighlightId)
        : undefined;
      if (anchorHighlight) {
        setScrolledToHighlightId(anchorHighlight.id);
        setCurrentPage(anchorHighlight.position.boundingRect.pageNumber);
        highlighterUtilsRef.current
          ?.getViewer()
          ?.scrollPageIntoView({ pageNumber: anchorHighlight.position.boundingRect.pageNumber });
      }
    },
    [highlights],
  );

  if (!loadedPdf) {
    return <UploadScreen onFileSelected={loadPdfFile} />;
  }

  const pdfPaneProps = {
    source: loadedPdf.source,
    highlights,
    areaMode,
    freetextMode,
    onFreetextClick: handleFreetextClick,
    addHighlight,
    editHighlight,
    deleteHighlight,
    utilsRef: (utils: PdfHighlighterUtils) => {
      highlighterUtilsRef.current = utils;
    },
    onOpenDive: handleOpenDive,
    onDiveDeeper: handleDiveDeeper,
    onDiveIntoExisting: handleDiveIntoExisting,
    onPin: handlePin,
    initialPage: currentPage,
    onPageChange: setCurrentPage,
    onDocumentReady: setPdfDocument,
    scrollToHighlightId: scrolledToHighlightId,
    pdfScaleValue,
    onZoomChange: setPdfScaleValue,
  };

  const dockTarget = !diveFocusId
    ? "workspace"
    : paneWindow(ancestorChain(panels, diveFocusId, loadedPdf.fileName)).some(
        (entry) => entry.id === null,
      )
      ? "deep-dive-root"
      : "offscreen";

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div className="toolbar-group toolbar-title-group">
          <strong className="toolbar-title">{loadedPdf.fileName}</strong>
        </div>
        <div className="toolbar-group toolbar-actions">
          {searchOpen ? (
            <SearchBar utilsRef={highlighterUtilsRef} onClose={() => setSearchOpen(false)} />
          ) : (
            <SearchToggleButton onClick={() => setSearchOpen(true)} />
          )}
          <div className="view-controls">
            <button type="button" onClick={zoomOut} title="Zoom out" aria-label="Zoom out">
              <ZoomOut size={16} />
            </button>
            {zoomEditValue !== null ? (
              <input
                type="number"
                className="view-controls-zoom-input"
                value={zoomEditValue}
                min={Math.round(MIN_ZOOM_SCALE * 100)}
                max={Math.round(MAX_ZOOM_SCALE * 100)}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setZoomEditValue(event.target.value)}
                onBlur={commitZoomEdit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitZoomEdit();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setZoomEditValue(null);
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="view-controls-zoom"
                onClick={startEditingZoom}
                title="Set zoom level"
              >
                {typeof pdfScaleValue === "number" ? `${Math.round(pdfScaleValue * 100)}%` : "Fit"}
              </button>
            )}
            <button type="button" onClick={zoomIn} title="Zoom in" aria-label="Zoom in">
              <ZoomIn size={16} />
            </button>
            <button
              type="button"
              className={twoPageView ? "active" : ""}
              onClick={toggleTwoPageView}
              title="Two-page view"
              aria-label="Two-page view"
              aria-pressed={twoPageView}
            >
              <Columns2 size={16} />
            </button>
            <button
              type="button"
              className={continuousScroll ? "active" : ""}
              onClick={toggleContinuousScroll}
              title="Continuous scrolling"
              aria-label="Continuous scrolling"
              aria-pressed={continuousScroll}
            >
              <Rows3 size={16} />
            </button>
          </div>
          <button
            type="button"
            className={areaMode ? "active" : ""}
            onClick={() => {
              setAreaMode((value) => !value);
              setFreetextMode(false);
            }}
          >
            Area highlight
          </button>
          <button
            type="button"
            className={freetextMode ? "active" : ""}
            onClick={() => {
              setFreetextMode((value) => !value);
              setAreaMode(false);
            }}
          >
            Sticky note
          </button>
          <button type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
          <button type="button" onClick={() => uploadInputRef.current?.click()}>
            Change PDF
          </button>
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) loadPdfFile(file);
            event.target.value = "";
          }}
        />
      </header>

      {diveFocusId ? (
        <DeepDiveView
          panels={panels}
          diveHighlights={diveHighlights}
          scrolledToDiveHighlightId={scrolledToDiveHighlightId}
          focusId={diveFocusId}
          rootLabel={loadedPdf.fileName}
          onFocusChange={setDiveFocusId}
          rootSlotRef={deepDiveRootSlotRef}
          onSendMessage={sendDiveMessage}
          onNestedDive={handleNestedDive}
          onAddHighlight={handleAddDiveHighlight}
          onEditHighlight={handleEditDiveHighlight}
          onDeleteHighlight={handleDeleteDiveHighlight}
          onDiveFromHighlight={handleDiveFromDiveHighlight}
          onPin={handlePin}
        />
      ) : (
        <div className="workspace">
          <Sidebar
            highlights={highlights}
            pins={pins}
            panels={panels}
            diveHighlights={diveHighlights}
            scrolledToHighlightId={scrolledToHighlightId}
            onJumpToHighlight={jumpToHighlight}
            onDeleteHighlight={(highlight) => deleteHighlight(highlight.id)}
            onOpenDiveFromHighlight={handleOpenDiveFromHighlight}
            onDeletePin={handleDeletePin}
            onOpenDiveHighlight={handleOpenDiveHighlight}
            onDeleteDiveHighlight={handleDeleteDiveHighlight}
            activePanel={activeSidebarPanel}
            onSelectPanel={handleSelectSidebarPanel}
            pdfDocument={pdfDocument}
            pageLabels={pageLabels}
            currentPage={currentPage}
            onGoToPage={goToPage}
          />

          <main className="viewer">
            <div className="pdf-pane-slot" ref={workspaceSlotRef} />
          </main>
        </div>
      )}

      <PersistentPdfPane
        pdfPaneProps={pdfPaneProps}
        dockTarget={dockTarget}
        workspaceSlotRef={workspaceSlotRef}
        deepDiveRootSlotRef={deepDiveRootSlotRef}
        highlighterUtilsRef={highlighterUtilsRef}
      />
    </div>
  );
}
