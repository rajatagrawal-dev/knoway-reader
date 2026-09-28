import {
  useCallback,
  useEffect,
  useMemo,
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
import { useTheme } from "./theme";
import Sidebar, { type SidebarPanel } from "./components/Sidebar";
import AppRail, { type HighlightPen, type Tool } from "./components/AppRail";
import type { SearchMatch } from "./components/SearchPanel";
import { HIGHLIGHT_COLOR_PRESETS } from "./highlightColors";
import type { CommentedHighlight } from "./types";
import "./App.css";
import PersistentPdfPane from "./deepdive/PersistentPdfPane";
import DeepDiveView from "./deepdive/DeepDiveView";
import type { DiveHighlight, DiveHighlightPlacement, DivePanel, GeneralNote, Pin } from "./deepdive/types";
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
  generalNotesKeyForFile,
  loadDiveHighlights,
  loadDivePanels,
  loadGeneralNotes,
  loadPins,
  pinsKeyForFile,
  saveDiveHighlights,
  saveDivePanels,
  saveGeneralNotes,
  savePins,
} from "./deepdive/store";
import { buildDiveSystem, openingMessage } from "./deepdive/prompts";
import { streamDiveReply } from "./deepdive/api";
import { parseDataUrlImage } from "./deepdive/image";
import { measureFreetextSize } from "./freetextSize";
import type { GlossaryTipBindings } from "./components/ExpandableTip";
import type { GlossaryFocusRequest } from "./components/GlossaryPanel";
import { GlossaryStore, glossaryKeyForFile } from "./glossary/store";
import {
  addGlossaryTerm,
  cancelGlossaryJob,
  getTextIndex,
  runGlossaryJob,
  type GlossaryJobContext,
} from "./glossary/job";
import type { GlossaryRef } from "./glossary/types";

type PdfSource = string | Uint8Array;

interface LoadedPdf {
  source: PdfSource;
  fileName: string;
  storageKey: string;
  divesKey: string;
  pinsKey: string;
  diveHighlightsKey: string;
  generalNotesKey: string;
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

// Export is hidden for now; handleExport is kept intact so flipping this
// back on restores it (as the last row of the View menu).
const SHOW_EXPORT_BUTTON = false;

// Highlight mode's color and style — a reader preference kept across
// documents, like the glossary-marks toggle below.
const HIGHLIGHT_PEN_STORAGE_KEY = "highlight-pen";

const DEFAULT_HIGHLIGHT_PEN: HighlightPen = { color: HIGHLIGHT_COLOR_PRESETS[0], style: "highlight" };

function loadHighlightPen(): HighlightPen {
  try {
    const saved = JSON.parse(localStorage.getItem(HIGHLIGHT_PEN_STORAGE_KEY) ?? "null");
    if (saved && typeof saved.color === "string" && typeof saved.style === "string") return saved;
  } catch {
    // Fall back to the default pen.
  }
  return DEFAULT_HIGHLIGHT_PEN;
}

// ⌘Z undoes changes to the PDF's own annotations (highlights and sticky
// notes): creating, editing, and deleting them.
const MAX_UNDO_ENTRIES = 100;

// Edits to one annotation this close together (typing into a sticky note,
// dragging it) undo as one step.
const UNDO_COALESCE_MS = 1500;

type UndoEntry =
  | { kind: "add"; id: string }
  | { kind: "edit"; before: CommentedHighlight; at: number }
  | {
      kind: "delete";
      highlight: CommentedHighlight;
      index: number;
      // The dive branch the deletion cascaded to (see deleteHighlight).
      panels: DivePanel[];
      diveHighlights: DiveHighlight[];
    };

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

// Whether glossary terms are underlined in the text — a reader preference
// kept across documents, unlike the per-file annotation data.
const GLOSSARY_MARKS_STORAGE_KEY = "glossary-marks-visible";

function loadGlossaryMarksVisible(): boolean {
  try {
    return localStorage.getItem(GLOSSARY_MARKS_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

// How long after a PDF opens to start indexing its text for glossary
// lookups — late enough not to compete with the first pages rendering.
const GLOSSARY_INDEX_DELAY_MS = 1500;

// How long the marker for a glossary reference just jumped to is kept. Its
// fade-out is a CSS animation that starts when it mounts — once the target
// page renders, which on a long smooth scroll is well after the click — so
// this only needs to outlast the scroll plus that animation.
const GLOSSARY_FLASH_MS = 6000;

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
  const [generalNotes, setGeneralNotes] = useState<GeneralNote[]>([]);
  const [diveFocusId, setDiveFocusId] = useState<string | null>(null);
  // Read by the PDF's highlights, which render in their own React roots
  // (inside react-pdf-highlighter) and so can't rely on fresh props.
  const diveFocusIdRef = useRef(diveFocusId);
  diveFocusIdRef.current = diveFocusId;
  // Select/Highlight stay on until changed; Area/Sticky note are one-shot
  // and, while set, take over from the base tool (see AppRail's Tool).
  const [baseTool, setBaseTool] = useState<"select" | "highlight">("select");
  const [oneShotTool, setOneShotTool] = useState<"area" | "note" | null>(null);
  const tool: Tool = oneShotTool ?? baseTool;
  const [highlightPen, setHighlightPen] = useState(loadHighlightPen);
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [scrolledToHighlightId, setScrolledToHighlightId] = useState<string | null>(
    null,
  );
  const [scrolledToDiveHighlightId, setScrolledToDiveHighlightId] = useState<string | null>(null);
  // The PDF highlight whose annotations-panel row is under the pointer. The
  // library renders each page's highlights in its own React root, so rather
  // than re-rendering those, a scoped <style> rule (below) outlines the
  // matching highlight via HighlightContainer's data-highlight-id.
  const [hoveredHighlightId, setHoveredHighlightId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Bumped to (re)focus the search panel's input, e.g. by ⌘F.
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
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
  const [glossaryStore] = useState(() => new GlossaryStore());
  const [glossaryFocusRequest, setGlossaryFocusRequest] = useState<GlossaryFocusRequest | null>(null);
  // Not saved with the other highlights — see jumpToGlossaryRef.
  const [glossaryFlash, setGlossaryFlash] = useState<CommentedHighlight | null>(null);
  const glossaryFlashTimerRef = useRef<number | undefined>(undefined);
  const [glossaryMarksVisible, setGlossaryMarksVisible] = useState(loadGlossaryMarksVisible);

  useEffect(() => {
    try {
      localStorage.setItem(GLOSSARY_MARKS_STORAGE_KEY, String(glossaryMarksVisible));
    } catch {
      // Not remembered across sessions; the toggle still works.
    }
  }, [glossaryMarksVisible]);

  useEffect(() => {
    try {
      localStorage.setItem(HIGHLIGHT_PEN_STORAGE_KEY, JSON.stringify(highlightPen));
    } catch {
      // Not remembered across sessions; the pen still works.
    }
  }, [highlightPen]);
  const [twoPageView, setTwoPageView] = useState(false);
  const [continuousScroll, setContinuousScroll] = useState(true);
  const { theme, toggleTheme } = useTheme();

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const highlightsRef = useRef(highlights);
  highlightsRef.current = highlights;
  const undoStackRef = useRef<UndoEntry[]>([]);
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

  // Glossary lookups run outside React (see glossary/job.ts) and read the
  // document they belong to from here at the moment they start.
  const glossaryContextRef = useRef<GlossaryJobContext | null>(null);
  glossaryContextRef.current =
    pdfDocument && loadedPdf ? { pdfDocument, fileName: loadedPdf.fileName, pageLabels } : null;

  useEffect(() => {
    if (!pdfDocument) return;
    const timer = window.setTimeout(() => {
      getTextIndex(pdfDocument).catch(() => {
        // A lookup will retry the extraction and surface the error itself.
      });
    }, GLOSSARY_INDEX_DELAY_MS);
    return () => window.clearTimeout(timer);
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
    saveGeneralNotes(loadedPdf.generalNotesKey, generalNotes);
  }, [generalNotes, loadedPdf]);

  // The file name lives in the window title now that there's no top bar.
  useEffect(() => {
    const title = loadedPdf ? `${loadedPdf.fileName} — MuseReader` : "MuseReader";
    document.title = title;
    if ("__TAURI_INTERNALS__" in window) {
      import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch(() => {
          // Keeps the default window title.
        });
    }
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
      const generalNotesKey = generalNotesKeyForFile(file);
      setLoadedPdf({
        source: new Uint8Array(arrayBuffer),
        fileName: file.name,
        storageKey,
        divesKey,
        pinsKey,
        diveHighlightsKey,
        generalNotesKey,
      });
      setHighlights(loadHighlights(storageKey));
      setPanels(loadDivePanels(divesKey));
      setPins(loadPins(pinsKey));
      setDiveHighlights(loadDiveHighlights(diveHighlightsKey));
      setGeneralNotes(loadGeneralNotes(generalNotesKey));
      glossaryStore.load(glossaryKeyForFile(file));
      setGlossaryFlash(null);
      setBaseTool("select");
      setOneShotTool(null);
      undoStackRef.current = [];
      setDiveFocusId(null);
      setCurrentPage(1);
      setPdfDocument(null);
    };
    reader.onerror = () => {
      alert("Failed to read the PDF file.");
    };
    reader.readAsArrayBuffer(file);
  }, [glossaryStore]);

  const pushUndo = (entry: UndoEntry) => {
    const stack = undoStackRef.current;
    stack.push(entry);
    if (stack.length > MAX_UNDO_ENTRIES) stack.shift();
  };

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
      createdAt: new Date().toISOString(),
    };
    setHighlights((previous) => [next, ...previous]);
    pushUndo({ kind: "add", id: next.id });
    if (highlight.type === "area") setOneShotTool((current) => (current === "area" ? null : current));
  };

  const editHighlight = (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => {
    const last = undoStackRef.current[undoStackRef.current.length - 1];
    if (last?.kind === "edit" && last.before.id === idToUpdate && Date.now() - last.at < UNDO_COALESCE_MS) {
      last.at = Date.now();
    } else {
      const before = highlightsRef.current.find((highlight) => highlight.id === idToUpdate);
      if (before) pushUndo({ kind: "edit", before, at: Date.now() });
    }
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
    const index = highlights.findIndex((h) => h.id === highlightId);
    const highlight = highlights[index];
    if (!highlight) return;
    const branchIds = highlight.divePanelId
      ? panelSubtreeIds(panelsRef.current, highlight.divePanelId)
      : new Set<string>();
    pushUndo({
      kind: "delete",
      highlight,
      index,
      panels: panelsRef.current.filter((panel) => branchIds.has(panel.id)),
      diveHighlights: diveHighlights.filter((h) => branchIds.has(h.panelId)),
    });
    setHighlights((previous) =>
      previous.filter((highlight) => highlight.id !== highlightId),
    );
    if (highlight.divePanelId) deletePanelSubtree(highlight.divePanelId, null);
  };

  const undo = () => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;
    if (entry.kind === "add") {
      // A highlight dived into since it was made now anchors a conversation;
      // undoing it would take that with it, so it stays.
      if (highlightsRef.current.find((h) => h.id === entry.id)?.divePanelId) return;
      setHighlights((previous) => previous.filter((h) => h.id !== entry.id));
    } else if (entry.kind === "edit") {
      setHighlights((previous) =>
        previous.map((h) =>
          h.id === entry.before.id ? { ...entry.before, divePanelId: h.divePanelId } : h,
        ),
      );
    } else {
      setHighlights((previous) => {
        if (previous.some((h) => h.id === entry.highlight.id)) return previous;
        const next = [...previous];
        next.splice(Math.min(entry.index, next.length), 0, entry.highlight);
        return next;
      });
      if (entry.panels.length > 0) {
        setPanels((previous) => [
          ...previous,
          ...entry.panels.filter((panel) => !previous.some((p) => p.id === panel.id)),
        ]);
        setDiveHighlights((previous) => [
          ...entry.diveHighlights.filter((h) => !previous.some((p) => p.id === h.id)),
          ...previous,
        ]);
      }
    }
  };

  const handleFreetextClick = (position: ScaledPosition) => {
    // Sized to fit the placeholder text rather than react-pdf-highlighter-
    // plus's hardcoded 150x80 default — the box then keeps re-fitting itself
    // as the text changes (see HighlightContainer's onTextChange).
    const { width, height } = measureFreetextSize("New note");
    const next: CommentedHighlight = {
      id: getNextId(),
      type: "freetext",
      position: {
        ...position,
        boundingRect: {
          ...position.boundingRect,
          x2: position.boundingRect.x1 + width,
          y2: position.boundingRect.y1 + height,
        },
      },
      content: { text: "New note" },
      createdAt: new Date().toISOString(),
    };
    setHighlights((previous) => [next, ...previous]);
    pushUndo({ kind: "add", id: next.id });
    setOneShotTool((current) => (current === "note" ? null : current));
  };

  // Editing a sticky note's text from the annotations panel rather than on
  // the PDF — re-fits its box to the new text like HighlightContainer's
  // onTextChange does. That path has the library's viewportToScaled; here
  // the measured (current-viewport) pixel size is converted to the note's
  // scaled units by hand: scaled coords are in the reference viewport's
  // pixels (boundingRect.width/height), so scale by reference / current.
  const handleEditFreetextText = (highlight: CommentedHighlight, text: string) => {
    const rect = highlight.position.boundingRect;
    const { width, height } = measureFreetextSize(text, highlight.fontSize, highlight.fontFamily);
    const viewport = highlighterUtilsRef.current?.getViewer()?.getPageView(rect.pageNumber - 1)?.viewport;
    const scaleX = viewport ? rect.width / viewport.width : 1;
    const scaleY = viewport ? rect.height / viewport.height : 1;
    editHighlight(highlight.id, {
      content: { text },
      position: {
        boundingRect: { ...rect, x2: rect.x1 + width * scaleX, y2: rect.y1 + height * scaleY },
        rects: [],
      },
    });
  };

  // A freeform note with no page/position of its own — for the Annotations
  // panel's quick-add textbox, when what's being jotted down isn't "about"
  // wherever the reader happens to be scrolled to right now.
  const handleAddGeneralNote = (text: string) => {
    const next: GeneralNote = { id: getNextId(), text, createdAt: new Date().toISOString() };
    setGeneralNotes((previous) => [next, ...previous]);
  };

  const handleEditGeneralNote = (id: string, text: string) => {
    setGeneralNotes((previous) => previous.map((note) => (note.id === id ? { ...note, text } : note)));
  };

  const handleDeleteGeneralNote = (id: string) => {
    setGeneralNotes((previous) => previous.filter((note) => note.id !== id));
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

  // Marks a passage with a brief, unsaved highlight (rendered by
  // HighlightContainer's GlossaryFlash) and scrolls it into view — for a
  // glossary reference or a search result.
  const flashPassage = (id: string, text: string, position: ScaledPosition) => {
    const flash: CommentedHighlight = {
      id: `flash-${id}-${Date.now()}`,
      type: "text",
      content: { text },
      position,
      glossaryFlash: true,
    };
    setGlossaryFlash(flash);
    highlighterUtilsRef.current?.scrollToHighlight(flash);
    window.clearTimeout(glossaryFlashTimerRef.current);
    glossaryFlashTimerRef.current = window.setTimeout(() => setGlossaryFlash(null), GLOSSARY_FLASH_MS);
  };

  const jumpToGlossaryRef = (ref: GlossaryRef) => flashPassage(`glossary-${ref.id}`, ref.match, ref.position);

  const jumpToSearchMatch = (match: SearchMatch) => flashPassage(`search-${match.id}`, match.match, match.position);

  const handleDeleteGlossaryEntry = (entryId: string) => {
    cancelGlossaryJob(entryId);
    glossaryStore.remove(entryId);
  };

  const retryGlossaryEntry = useCallback(
    (entryId: string) => {
      const context = glossaryContextRef.current;
      if (context) void runGlossaryJob(glossaryStore, entryId, context);
    },
    [glossaryStore],
  );

  // Handed to the selection tip, whose content react-pdf-highlighter
  // captures once per selection — so these read everything live (refs, the
  // store) rather than closing over render-time values.
  const glossaryBindings = useMemo<GlossaryTipBindings>(
    () => ({
      store: glossaryStore,
      onAdd: (selection, pageNumber) => {
        const context = glossaryContextRef.current;
        return context ? addGlossaryTerm(glossaryStore, selection, pageNumber, context) : null;
      },
      onOpenInGlossary: (entryId) => {
        setDiveFocusId(null);
        setActiveSidebarPanel("glossary");
        setGlossaryFocusRequest({ entryId, nonce: Date.now() });
      },
      onRetry: retryGlossaryEntry,
    }),
    [glossaryStore, retryGlossaryEntry],
  );

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
  const zoomToFit = () => setPdfScaleValue("auto");

  const currentZoomPercent = () =>
    typeof pdfScaleValue === "number"
      ? Math.round(pdfScaleValue * 100)
      : Math.round((highlighterUtilsRef.current?.getViewer()?.currentScale ?? 1) * 100);

  const setZoomPercent = (percent: number) => {
    setPdfScaleValue(Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, percent / 100)));
  };

  const toggleTwoPageView = () => {
    const next = !twoPageView;
    setTwoPageView(next);
    const viewer = highlighterUtilsRef.current?.getViewer();
    if (viewer) viewer.spreadMode = next ? SpreadMode.ODD : SpreadMode.NONE;
  };

  const toggleContinuousScroll = () => setContinuousScroll((value) => !value);

  // Side panels belong to the main workspace, so picking one from the rail
  // while in Deep Dive returns there with that panel open (as "Open in
  // glossary" does).
  const handleSelectSidebarPanel = (panel: SidebarPanel) => {
    if (diveFocusId) {
      setDiveFocusId(null);
      setActiveSidebarPanel(panel);
      return;
    }
    setActiveSidebarPanel((current) => (current === panel ? null : panel));
  };

  const openSearch = () => {
    setDiveFocusId(null);
    setActiveSidebarPanel("search");
    setSearchFocusRequest((value) => value + 1);
  };

  // Picking Area or Sticky note again cancels it, back to the base tool.
  const selectTool = (next: Tool) => {
    if (next === "area" || next === "note") {
      setOneShotTool((current) => (current === next ? null : next));
    } else {
      setBaseTool(next);
      setOneShotTool(null);
    }
  };

  // Escape steps back toward plain Select: a one-shot tool first, then
  // Highlight mode.
  const escapeTool = () => {
    if (oneShotTool) setOneShotTool(null);
    else setBaseTool("select");
  };

  // Read by the one window-level key listener below, which is registered
  // once per document rather than on every render.
  const shortcutsRef = useRef({ openSearch, undo, zoomIn, zoomOut, zoomToFit, escapeTool });
  shortcutsRef.current = { openSearch, undo, zoomIn, zoomOut, zoomToFit, escapeTool };

  useEffect(() => {
    if (!loadedPdf) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcuts = shortcutsRef.current;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "f") {
        event.preventDefault();
        shortcuts.openSearch();
      } else if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        shortcuts.zoomIn();
      } else if (mod && key === "-") {
        event.preventDefault();
        shortcuts.zoomOut();
      } else if (mod && key === "0") {
        event.preventDefault();
        shortcuts.zoomToFit();
      } else if (mod && key === "z" && !event.shiftKey && !event.altKey) {
        // Text fields keep their own undo.
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        shortcuts.undo();
      } else if (key === "escape" && !mod && !isEditableTarget(event.target)) {
        shortcuts.escapeTool();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadedPdf]);

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
      // Not an undoable edit (see undo): it links the highlight to its dive.
      setHighlights((previous) =>
        previous.map((highlight) => (highlight.id === highlightId ? { ...highlight, divePanelId: panel.id } : highlight)),
      );
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleNestedDive = useCallback(
    ({
      parentId,
      selection,
      contextText,
      turnIndex,
      occurrence,
    }: { parentId: string; selection: string; contextText: string } & DiveHighlightPlacement) => {
      const panel = createNestedPanel({ parentId, selection, contextText });
      // Mirrors handleDiveDeeper's root-level CommentedHighlight: without a
      // DiveHighlight carrying divePanelId, this new dive would have no
      // annotation row at all, so it wouldn't show up in the annotations
      // panel (and couldn't be jumped back to from there).
      setDiveHighlights((previous) => [
        {
          id: getNextId(),
          panelId: parentId,
          text: selection,
          divePanelId: panel.id,
          turnIndex,
          occurrence,
          createdAt: new Date().toISOString(),
        },
        ...previous,
      ]);
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
      style?: Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "divePanelId"> & DiveHighlightPlacement,
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

  const handleEditPinComment = (pinId: string, comment: string) => {
    setPins((previous) => previous.map((pin) => (pin.id === pinId ? { ...pin, comment } : pin)));
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
    highlights: glossaryFlash ? [...highlights, glossaryFlash] : highlights,
    tool,
    pen: highlightPen,
    onFreetextClick: handleFreetextClick,
    addHighlight,
    editHighlight,
    deleteHighlight,
    utilsRef: (utils: PdfHighlighterUtils) => {
      highlighterUtilsRef.current = utils;
    },
    onOpenDive: handleOpenDive,
    isDiveOpen: (divePanelId: string) => diveFocusIdRef.current === divePanelId,
    onDiveDeeper: handleDiveDeeper,
    onDiveIntoExisting: handleDiveIntoExisting,
    onPin: handlePin,
    glossary: glossaryBindings,
    glossaryMarks: glossaryMarksVisible,
    notesCollapsed,
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
      {hoveredHighlightId ? (
        <style>{`.highlight-anchor[data-highlight-id="${CSS.escape(hoveredHighlightId)}"] :is(.TextHighlight__part, .AreaHighlight__part, .FreetextHighlight__container) { box-shadow: 0 0 0 2px var(--rphp-accent, #5b50e6); }`}</style>
      ) : null}
      <AppRail
        activePanel={diveFocusId ? null : activeSidebarPanel}
        onSelectPanel={handleSelectSidebarPanel}
        tool={tool}
        onSelectTool={selectTool}
        pen={highlightPen}
        onPenChange={setHighlightPen}
        view={{
          zoomLabel: typeof pdfScaleValue === "number" ? `${Math.round(pdfScaleValue * 100)}%` : "Fit",
          currentZoomPercent,
          onZoomIn: zoomIn,
          onZoomOut: zoomOut,
          onZoomFit: zoomToFit,
          onZoomSet: setZoomPercent,
          minZoomPercent: Math.round(MIN_ZOOM_SCALE * 100),
          maxZoomPercent: Math.round(MAX_ZOOM_SCALE * 100),
          twoPageView,
          onToggleTwoPageView: toggleTwoPageView,
          continuousScroll,
          onToggleContinuousScroll: toggleContinuousScroll,
          notesCollapsed,
          onToggleNotesCollapsed: () => setNotesCollapsed((value) => !value),
          theme,
          onToggleTheme: toggleTheme,
          footer: SHOW_EXPORT_BUTTON ? (
            <>
              <div className="rail-popover-separator" />
              <button type="button" className="view-menu-action" onClick={handleExport} disabled={exporting}>
                {exporting ? "Exporting…" : "Export PDF"}
              </button>
            </>
          ) : null,
        }}
      />

      <div className="app-main">

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
              onHoverHighlight={setHoveredHighlightId}
              onEditFreetextText={handleEditFreetextText}
              onEditHighlightComment={(highlight, comment) => editHighlight(highlight.id, { comment })}
              onOpenDiveFromHighlight={handleOpenDiveFromHighlight}
              onDeletePin={handleDeletePin}
              onEditPinComment={handleEditPinComment}
              onOpenDiveHighlight={handleOpenDiveHighlight}
              onDeleteDiveHighlight={handleDeleteDiveHighlight}
              onEditDiveHighlightComment={(highlightId, comment) => handleEditDiveHighlight(highlightId, { comment })}
              generalNotes={generalNotes}
              onAddNote={handleAddGeneralNote}
              onEditGeneralNote={handleEditGeneralNote}
              onDeleteGeneralNote={handleDeleteGeneralNote}
              activePanel={activeSidebarPanel}
              onSelectPanel={handleSelectSidebarPanel}
              pdfDocument={pdfDocument}
              pageLabels={pageLabels}
              currentPage={currentPage}
              onGoToPage={goToPage}
              glossaryStore={glossaryStore}
              glossaryFocusRequest={glossaryFocusRequest}
              onJumpToGlossaryRef={jumpToGlossaryRef}
              onRetryGlossaryEntry={retryGlossaryEntry}
              onDeleteGlossaryEntry={handleDeleteGlossaryEntry}
              glossaryMarksVisible={glossaryMarksVisible}
              onGlossaryMarksVisibleChange={setGlossaryMarksVisible}
              searchQuery={searchQuery}
              onSearchQueryChange={setSearchQuery}
              searchFocusRequest={searchFocusRequest}
              onJumpToSearchMatch={jumpToSearchMatch}
            />

            <main className="viewer">
              <div className="pdf-pane-slot" ref={workspaceSlotRef} />
            </main>
          </div>
        )}
      </div>

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
