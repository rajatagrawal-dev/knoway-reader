import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
  historyTurns,
  replacePanel,
  rootPanelOf,
} from "./deepdive/tree";
import { getStorage } from "./storage";
import { openDocument, titleFromFileName } from "./storage/documents";
import { isEpub, pdfForEpub } from "./epub";
import type { DocumentMeta } from "./storage/types";
import LibraryHome from "./library/LibraryHome";
import { showNotice } from "./components/notices";
import { openExternal } from "./library/desktop";
import { pickTitle } from "./library/library";
import { readPdfInfoFromDocument } from "./library/pdfInfo";
import { sentenceAround, type XrefRef, type XrefTarget } from "./xref/detect";
import { cropTarget } from "./xref/preview";
import { DocDataWriter } from "./storage/docDataWriter";
import { buildDivePrompt, openingMessage } from "./deepdive/prompts";
import { getExperiments } from "./deepdive/experiments";
import { divePromptOptions, prepareDiveSources, type DiveRequestContext } from "./deepdive/diveRequest";
import { mergeSuggestions, splitSuggestions, suggestedDiveSources, type DiveSuggestion } from "./deepdive/suggestions";
import { buildTreeSummaryRequest, treeAnswerCount } from "./deepdive/summary";
import { streamDiveReply } from "./deepdive/api";
import { downscaleImage, parseDataUrlImage } from "./deepdive/image";
import { measureFreetextSize } from "./freetextSize";
import type { GlossaryTipBindings } from "./components/ExpandableTip";
import type { GlossaryFocusRequest } from "./components/GlossaryPanel";
import { GlossaryStore } from "./glossary/store";
import {
  addGlossaryTerm,
  cancelGlossaryJob,
  runGlossaryJob,
  type GlossaryJobContext,
} from "./glossary/job";
import { getTextIndex, setActiveDocument } from "./text/documentText";
import { matchPosition } from "./glossary/textIndex";
import { citedSources, markersToPages } from "./grounding/citations";
import type { ResolvedRef } from "./grounding/CitationChip";
import type { SourceRef } from "./grounding/types";
import {
  addAttachment,
  attachmentImages,
  attachmentInstructions,
  makeAttachment,
  makeRegionAttachment,
  type Attachment,
} from "./grounding/attachments";
import type { SendOptions } from "./deepdive/DivePanelPane";
import { AskStore } from "./ask/store";
import type { AskContext } from "./ask/job";
import type { AskThread } from "./ask/types";
import PageNavigator from "./navigation/PageNavigator";
import { NavigationHistory, placeFromScroll, scrollTopForPlace, type ReadingPlace } from "./navigation/history";
import { formatPageLabel } from "./pageLabels";
import type { GlossaryEntry, GlossaryRef } from "./glossary/types";

type PdfSource = string | Uint8Array;

interface LoadedPdf {
  source: PdfSource;
  fileName: string;
  docId: string; // content hash — the key for everything stored about it
  title: string; // as the library shows it
  sourceUrl?: string; // the web page it was saved from (src/web/)
}

const getNextId = () => crypto.randomUUID();

// A dive follow-up re-sends only the last two exchanges before it (roadmap
// §5.2): the selection and its sources already travel in the system prompt.
const DIVE_HISTORY_TURNS = 4;

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
  // Read by long-lived callbacks (sending a dive message) at call time.
  const pdfDocumentRef = useRef(pdfDocument);
  pdfDocumentRef.current = pdfDocument;
  const pageLabelsRef = useRef(pageLabels);
  pageLabelsRef.current = pageLabels;
  // The book's own label for a page ("xii", "42").
  const pageLabelFor = useCallback((pageNumber: number) => formatPageLabel(pageLabelsRef.current, pageNumber), []);
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
  const [docDataWriter] = useState(() => new DocDataWriter(getStorage()));
  // Ask threads: a store outside React (answers keep streaming when the panel
  // closes), the thread left open, and ⌘J's request to focus the composer.
  const [askStore] = useState(() => new AskStore());
  const [openAskThreadId, setOpenAskThreadId] = useState<string | null>(null);
  const [askFocusRequest, setAskFocusRequest] = useState(0);
  // Text the reader added to their next question ("Add to question"): for
  // the Ask panel, and per dive.
  const [askAttachments, setAskAttachments] = useState<Attachment[]>([]);
  const [diveAttachments, setDiveAttachments] = useState<Record<string, Attachment[]>>({});
  // Where the reader was before each jump (Back) and where Back took them
  // from (Forward) — kept outside React, so each change bumps
  // a version to re-render the page navigator. `recentJump` is the latest
  // jump, for telling where the reader is while the viewer is still on its
  // way (see placeHere): `landing` is where it goes (a place already read
  // when `revisit`, i.e. reached by Back or Forward) and `arrived` turns
  // true once the viewer gets there.
  const [navHistory] = useState(() => new NavigationHistory());
  const [, bumpHistory] = useReducer((version: number) => version + 1, 0);
  const [recentJump, setRecentJump] = useState<{ landing: ReadingPlace; revisit: boolean; arrived: boolean } | null>(
    null,
  );
  // ⌥⌘G's request to put the cursor in the page navigator's page number.
  const [pageInputFocusRequest, setPageInputFocusRequest] = useState(0);
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

  // The open document's library entry, kept up to date with where the reader
  // is — page, zoom, layout, open panel — and saved a moment after that
  // changes (at once when leaving the document), for "Continue reading" and
  // to reopen it just so.
  const openMetaRef = useRef<DocumentMeta | null>(null);
  const pendingZoomRef = useRef<number | "auto" | null>(null);
  const readingStateTimer = useRef<number | undefined>(undefined);
  const readingState = {
    lastPage: currentPage,
    view: { zoom: pdfScaleValue, twoPage: twoPageView, continuous: continuousScroll, panel: activeSidebarPanel },
  };
  const readingStateRef = useRef(readingState);
  readingStateRef.current = readingState;

  const flushReadingState = useCallback(async () => {
    if (readingStateTimer.current === undefined) return;
    window.clearTimeout(readingStateTimer.current);
    readingStateTimer.current = undefined;
    const meta = openMetaRef.current;
    if (!meta) return;
    const { lastPage, view } = readingStateRef.current;
    const zoom = typeof view.zoom === "number" || view.zoom === "auto" ? view.zoom : "auto";
    const updated: DocumentMeta = { ...meta, lastPage, view: { ...view, zoom } };
    openMetaRef.current = updated;
    await getStorage()
      .putMeta(updated)
      .catch(() => {
        // Not saved: the document still opens, just at the start.
      });
  }, []);

  useEffect(() => {
    if (!openMetaRef.current) return;
    window.clearTimeout(readingStateTimer.current);
    readingStateTimer.current = window.setTimeout(() => void flushReadingState(), 800);
  }, [currentPage, pdfScaleValue, twoPageView, continuousScroll, activeSidebarPanel, flushReadingState]);
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

  // A document opened before the library existed (or added by opening it
  // directly) has no page count, cover or embedded title yet: fill them in
  // from the PDF once it's loaded. A title the reader has set is kept.
  useEffect(() => {
    const meta = openMetaRef.current;
    if (!pdfDocument || !meta || meta.pageCount) return;
    let cancelled = false;
    void (async () => {
      const info = await readPdfInfoFromDocument(pdfDocument);
      const current = openMetaRef.current;
      if (cancelled || !current || current.docId !== meta.docId) return;
      const fileTitle = titleFromFileName(current.fileName);
      const title = current.title === fileTitle ? pickTitle(info.title, fileTitle) : current.title;
      const updated: DocumentMeta = {
        ...current,
        title,
        pageCount: info.pageCount,
        ...(info.author && !current.author ? { author: info.author } : {}),
      };
      openMetaRef.current = updated;
      const storage = getStorage();
      await storage.putMeta(updated).catch(() => {});
      if (info.thumbnail) await storage.putData(meta.docId, "thumbnail", info.thumbnail).catch(() => {});
      setLoadedPdf((loaded) => (loaded && loaded.docId === meta.docId ? { ...loaded, title } : loaded));
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  // Two-page layout is set on the viewer itself; a reopened document gets
  // the layout (and zoom) it was last read at once its viewer exists.
  useEffect(() => {
    if (!pdfDocument) return;
    const frame = requestAnimationFrame(() => {
      const viewer = highlighterUtilsRef.current?.getViewer();
      if (viewer) viewer.spreadMode = twoPageView ? SpreadMode.ODD : SpreadMode.NONE;
      const zoom = pendingZoomRef.current;
      pendingZoomRef.current = null;
      if (zoom !== null && zoom !== "auto") setPdfScaleValue(zoom);
    });
    return () => cancelAnimationFrame(frame);
  }, [pdfDocument, twoPageView]);

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
    docDataWriter.schedule(loadedPdf.docId, "highlights", highlights);
  }, [docDataWriter, highlights, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    docDataWriter.schedule(loadedPdf.docId, "dives", panels);
  }, [docDataWriter, panels, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    docDataWriter.schedule(loadedPdf.docId, "pins", pins);
  }, [docDataWriter, pins, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    docDataWriter.schedule(loadedPdf.docId, "diveHighlights", diveHighlights);
  }, [docDataWriter, diveHighlights, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    docDataWriter.schedule(loadedPdf.docId, "generalNotes", generalNotes);
  }, [docDataWriter, generalNotes, loadedPdf]);

  // Saves are debounced; don't lose the last few hundred milliseconds of
  // changes when the window closes.
  useEffect(() => {
    const flush = () => void docDataWriter.flush();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [docDataWriter]);

  // The file name lives in the window title now that there's no top bar.
  useEffect(() => {
    const title = loadedPdf ? `${loadedPdf.title} — Knowbel Reader` : "Knowbel Reader";
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

  // Arrow keys turn pages. ← and → always do — unless the page is zoomed
  // wider than the pane, when they scroll it sideways as usual. ↑ and ↓ do
  // too with continuous scrolling off (the same "no partial movement" rule
  // as the wheel above), and scroll as usual with it on. Ignored while a
  // modifier key is held (so browser/OS shortcuts still work), while typing
  // in an editable field (search box, comment box, dive composer, etc), and
  // while the PDF is out of sight in Deep Dive.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      const viewer = highlighterUtilsRef.current?.getViewer();
      if (!viewer || viewer.container.closest(".pdf-pane-offscreen-host")) return;
      const sideways = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if (!sideways && continuousScroll) return;
      if (sideways && viewer.container.scrollWidth > viewer.container.clientWidth + 1) return;
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

  // Opens a PDF in the reader: from the library (its id known), or a file
  // opened directly (⌘O in the reader), which is added to the library first.
  const openPdf = useCallback(
    async (bytes: Uint8Array, fileName: string, options: { legacyFile?: File; docId?: string } = {}) => {
      // The previous document's pending saves go to the previous document.
      await docDataWriter.flush();
      await flushReadingState();

      let opened;
      try {
        // Finds the PDF in the library by content (adding it if new), moving
        // over any notes the pre-library app kept in localStorage.
        opened = await openDocument(
          getStorage(),
          { bytes, fileName, legacyFile: options.legacyFile, docId: options.docId },
          localStorage,
        );
      } catch (error) {
        console.error(error);
        showNotice("Failed to open the PDF from the library.");
        return;
      }

      const { docId } = opened.meta;
      const stored = <T,>(kind: keyof typeof opened.data): T[] => {
        const value = opened.data[kind];
        return Array.isArray(value) ? (value as T[]) : [];
      };
      const loadedHighlights = stored<CommentedHighlight>("highlights");
      const loadedPanels = stored<DivePanel>("dives");
      const loadedPins = stored<Pin>("pins");
      const loadedDiveHighlights = stored<DiveHighlight>("diveHighlights");
      const loadedGeneralNotes = stored<GeneralNote>("generalNotes");
      const loadedGlossary = stored<GlossaryEntry>("glossary");
      const loadedThreads = stored<AskThread>("threads");

      // Before the viewer mounts: the text index cache is keyed by it.
      setActiveDocument(docId);
      openMetaRef.current = opened.meta;
      setLoadedPdf({
        source: bytes,
        fileName,
        docId,
        title: opened.meta.title,
        ...(opened.meta.source ? { sourceUrl: opened.meta.source.canonicalUrl || opened.meta.source.url } : {}),
      });
      // Prime with the arrays actually put in state, so the save effects
      // see them as already stored and don't write them straight back.
      docDataWriter.prime(docId, "highlights", loadedHighlights);
      docDataWriter.prime(docId, "dives", loadedPanels);
      docDataWriter.prime(docId, "pins", loadedPins);
      docDataWriter.prime(docId, "diveHighlights", loadedDiveHighlights);
      docDataWriter.prime(docId, "generalNotes", loadedGeneralNotes);
      setHighlights(loadedHighlights);
      setPanels(loadedPanels);
      setPins(loadedPins);
      setDiveHighlights(loadedDiveHighlights);
      setGeneralNotes(loadedGeneralNotes);
      glossaryStore.load(loadedGlossary, (entries) => docDataWriter.schedule(docId, "glossary", entries));
      askStore.load(loadedThreads, (threads) => docDataWriter.schedule(docId, "threads", threads));
      setOpenAskThreadId(null);
      setAskAttachments([]);
      setDiveAttachments({});
      setGlossaryFlash(null);
      navHistory.clear();
      bumpHistory();
      setRecentJump(null);
      setBaseTool("select");
      setOneShotTool(null);
      undoStackRef.current = [];
      setDiveFocusId(null);
      setPdfDocument(null);
      // Back where the reader left off: page, zoom, layout, open panel.
      const view = opened.meta.view;
      setCurrentPage(opened.meta.lastPage ?? 1);
      // A fixed zoom is applied once the document is ready (below): given to
      // the viewer before it has pages, it tries to scroll to one that
      // doesn't exist yet.
      setPdfScaleValue("auto");
      pendingZoomRef.current = view?.zoom ?? null;
      setTwoPageView(view?.twoPage ?? false);
      setContinuousScroll(view?.continuous ?? true);
      setActiveSidebarPanel(view ? (view.panel as SidebarPanel | null) : "toc");
    },
    [askStore, docDataWriter, flushReadingState, glossaryStore, navHistory],
  );

  const loadPdfFile = useCallback(
    async (file: File) => {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        showNotice(`Failed to read the ${isEpub(file) ? "EPUB" : "PDF"} file.`);
        return;
      }
      if (!isEpub(file)) {
        await openPdf(bytes, file.name, { legacyFile: file });
        return;
      }
      // An EPUB reads as the PDF it's converted to — converted once, the
      // first time it's opened or added.
      let epub;
      document.documentElement.style.cursor = "progress";
      try {
        epub = await pdfForEpub(getStorage(), bytes);
      } catch (error) {
        console.error(error);
        showNotice(error instanceof Error && error.message ? error.message : "Failed to read the EPUB file.");
        return;
      } finally {
        document.documentElement.style.cursor = "";
      }
      await openPdf(epub.pdf, file.name, { docId: epub.docId });
    },
    [openPdf],
  );

  const openFromLibrary = useCallback(
    async (meta: DocumentMeta) => {
      const bytes = await getStorage()
        .getFile(meta.docId)
        .catch(() => null);
      if (!bytes) {
        showNotice(`The PDF of “${meta.title}” couldn't be read from the library.`);
        return;
      }
      await openPdf(bytes, meta.fileName, { docId: meta.docId });
    },
    [openPdf],
  );

  // Back to the library, saving everything about the document first.
  const goHome = useCallback(async () => {
    await docDataWriter.flush();
    await flushReadingState();
    openMetaRef.current = null;
    setActiveDocument(null);
    setDiveFocusId(null);
    setPdfDocument(null);
    setLoadedPdf(null);
  }, [docDataWriter, flushReadingState]);

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
      anchor.download = titleFromFileName(loadedPdf.fileName) + "-annotated.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      showNotice("Failed to export PDF. See console for details.");
    } finally {
      setExporting(false);
    }
  };

  const currentPlace = (): ReadingPlace | null => {
    const viewer = highlighterUtilsRef.current?.getViewer();
    if (!viewer) return null;
    const pageNumber = viewer.currentPageNumber;
    const bounds = getPageVerticalBounds(viewer.container, pageNumber);
    return bounds ? placeFromScroll(viewer.container.scrollTop, pageNumber, bounds) : { pageNumber, offset: 0 };
  };

  // Where the reader is, for Back or Forward to return to: while the viewer
  // is still travelling to the last jump's target (clicking through search
  // results faster than it scrolls), the spot it's passing isn't a place
  // anyone was reading — the target is.
  const placeHere = (): ReadingPlace | null =>
    recentJump && !recentJump.arrived ? recentJump.landing : currentPlace();

  // Call before jumping to `targetPage`: Back then returns to where the
  // reader is now. While the viewer is still travelling to the previous
  // target (see placeHere), that target is where they are if Back or
  // Forward was taking them to it; a jump's target they haven't read yet,
  // so Back keeps pointing at the last place they actually were.
  const rememberPlace = (targetPage: number) => {
    const here = currentPlace();
    if (!here || here.pageNumber === targetPage) return;
    const left = !recentJump || recentJump.arrived ? here : recentJump.revisit ? recentJump.landing : null;
    if (left) navHistory.push(left);
    else navHistory.discardForward();
    bumpHistory();
    setRecentJump({ landing: { pageNumber: targetPage, offset: 0 }, revisit: false, arrived: false });
  };

  const showPlace = (place: ReadingPlace) => {
    const viewer = highlighterUtilsRef.current?.getViewer();
    if (!viewer) return;
    // Onto the page first (in paged mode it may not be laid out yet), then
    // to the exact spot on it.
    viewer.scrollPageIntoView({ pageNumber: place.pageNumber });
    requestAnimationFrame(() => {
      const bounds = getPageVerticalBounds(viewer.container, place.pageNumber);
      if (bounds) viewer.container.scrollTop = scrollTopForPlace(place, bounds);
    });
  };

  // Back (or Forward) over `steps` places at once — one for the button and
  // ⌘← / ⌘→, more from the navigator's list of places.
  const travel = (direction: "back" | "forward", steps = 1) => {
    if (!highlighterUtilsRef.current?.getViewer()) return;
    const here = placeHere();
    const place = direction === "back" ? navHistory.back(here, steps) : navHistory.forward(here, steps);
    if (!place) return;
    bumpHistory();
    setRecentJump({ landing: place, revisit: true, arrived: false });
    showPlace(place);
  };
  const goBack = (steps = 1) => travel("back", steps);
  const goForward = (steps = 1) => travel("forward", steps);

  useEffect(() => {
    setRecentJump((jump) =>
      jump && !jump.arrived && Math.abs(currentPage - jump.landing.pageNumber) <= 1 ? { ...jump, arrived: true } : jump,
    );
  }, [currentPage]);

  // A jump that never registers as arriving (the target was already on
  // screen) still arrives.
  useEffect(() => {
    if (!recentJump || recentJump.arrived) return;
    const timer = window.setTimeout(
      () => setRecentJump((jump) => (jump && !jump.arrived ? { ...jump, arrived: true } : jump)),
      3000,
    );
    return () => window.clearTimeout(timer);
  }, [recentJump]);

  const jumpToHighlight = (highlight: CommentedHighlight) => {
    rememberPlace(highlight.position.boundingRect.pageNumber);
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
    rememberPlace(position.boundingRect.pageNumber);
    setGlossaryFlash(flash);
    highlighterUtilsRef.current?.scrollToHighlight(flash);
    window.clearTimeout(glossaryFlashTimerRef.current);
    glossaryFlashTimerRef.current = window.setTimeout(() => setGlossaryFlash(null), GLOSSARY_FLASH_MS);
  };

  const jumpToGlossaryRef = (ref: GlossaryRef) => flashPassage(`glossary-${ref.id}`, ref.match, ref.position);
  // For the selection tip's bindings, which must read it live (see below).
  const jumpToGlossaryRefRef = useRef(jumpToGlossaryRef);
  jumpToGlossaryRefRef.current = jumpToGlossaryRef;

  const jumpToSearchMatch = (match: SearchMatch) => flashPassage(`search-${match.id}`, match.match, match.position);

  // A citation chip or source clicked in a dive: show the sentence the claim
  // rests on, flashed in the PDF. The PDF shares the Deep Dive screen with
  // the chain's first dive only, so from a deeper one that view comes up
  // first — with an instant jump to the page, since the pane is being
  // reparented (see handleOpenDiveHighlight), and the smooth flash after.
  const jumpToSource = async ({ source, range }: ResolvedRef) => {
    const pdf = pdfDocumentRef.current;
    if (!pdf || !loadedPdf) return;
    let position: ScaledPosition | null = null;
    let text = source.text;
    try {
      const page = (await getTextIndex(pdf)).pages[source.pageNumber - 1];
      if (page) {
        position = matchPosition({ page, start: range[0], end: range[1] });
        text = page.text.slice(range[0], range[1]);
      }
    } catch {
      // No index: the page itself is the best we can show.
    }

    const focus = diveFocusIdRef.current;
    let delay = 0;
    if (focus && !paneWindow(ancestorChain(panelsRef.current, focus, loadedPdf.fileName)).some((e) => e.id === null)) {
      const root = rootPanelOf(panelsRef.current, focus);
      if (root) {
        setDiveFocusId(root.id);
        setCurrentPage(source.pageNumber);
        highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber: source.pageNumber });
        delay = 80;
      }
    }
    window.setTimeout(() => {
      if (position) flashPassage(`cite-${source.pageNumber}-${range[0]}`, text, position);
      else goToPage(source.pageNumber);
    }, delay);
  };

  const handleDeleteGlossaryEntry = (entryId: string) => {
    cancelGlossaryJob(entryId);
    glossaryStore.remove(entryId);
  };

  const retryGlossaryEntry = useCallback(
    (entryId: string) => {
      const context = glossaryContextRef.current;
      if (!context || !glossaryStore.get(entryId)) return;
      void runGlossaryJob(glossaryStore, entryId, context);
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
      pageLabel: pageLabelFor,
      onOpenInGlossary: (entryId) => {
        setDiveFocusId(null);
        setActiveSidebarPanel("glossary");
        setGlossaryFocusRequest({ entryId, nonce: Date.now() });
      },
      onJumpToRef: (ref) => jumpToGlossaryRefRef.current(ref),
      onRetry: retryGlossaryEntry,
    }),
    [glossaryStore, retryGlossaryEntry, pageLabelFor],
  );

  const goToPage = (pageNumber: number) => {
    rememberPlace(pageNumber);
    highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber });
  };

  // Page turns aren't jumps: Back doesn't count them. pdf.js's own turns
  // step over a whole spread in two-page view.
  const previousPage = () => highlighterUtilsRef.current?.getViewer()?.previousPage();
  const nextPage = () => highlighterUtilsRef.current?.getViewer()?.nextPage();

  const focusPageInput = () => setPageInputFocusRequest((request) => request + 1);

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

  // "Add to question" from any selection: into the dive being read when in
  // Deep Dive, otherwise into the Ask panel (opening it). Reads the current
  // mode through refs — the PDF's selection tip is rendered once per
  // selection and would otherwise act on a stale one.
  const pushAttachment = useCallback((attachment: Attachment, divePanelId?: string) => {
      const targetDive = divePanelId ?? diveFocusIdRef.current;
      if (targetDive) {
        setDiveAttachments((all) => ({ ...all, [targetDive]: addAttachment(all[targetDive] ?? [], attachment) }));
        return;
      }
      setAskAttachments((list) => addAttachment(list, attachment));
      setActiveSidebarPanel("ask");
      setAskFocusRequest((value) => value + 1);
    }, []);

  const addToQuestion = useCallback(
    (kind: Attachment["kind"], text: string, pageNumber?: number, divePanelId?: string) => {
      const attachment = makeAttachment(kind, text, pageNumber);
      if (attachment) pushAttachment(attachment, divePanelId);
    },
    [pushAttachment],
  );

  // From the PDF (a fresh selection or an existing highlight): text as is;
  // an area as its screenshot, scaled down like a dive's, plus whatever PDF
  // text lies inside it.
  const addPdfContentToQuestion = useCallback(
    async (content: GhostHighlight["content"], position: ScaledPosition) => {
      const pageNumber = position.boundingRect.pageNumber;
      if (content.text) {
        addToQuestion("document", content.text, pageNumber);
        return;
      }
      const parsed = parseDataUrlImage(content.image);
      if (!parsed) return;
      const image = await downscaleImage(parsed);
      let page = null;
      try {
        const pdf = pdfDocumentRef.current;
        if (pdf) page = (await getTextIndex(pdf)).pages[pageNumber - 1] ?? null;
      } catch {
        // No text for the region: the image alone.
      }
      pushAttachment(makeRegionAttachment(image, pageNumber, page, position.boundingRect));
    },
    [addToQuestion, pushAttachment],
  );

  const openAsk = () => {
    setDiveFocusId(null);
    setActiveSidebarPanel("ask");
    setAskFocusRequest((value) => value + 1);
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
  // ⌘O in the reader opens another PDF (adding it to the library).
  const openFileInputRef = useRef<HTMLInputElement>(null);
  const openFile = () => openFileInputRef.current?.click();

  const shortcuts = { openSearch, openAsk, openFile, undo, zoomIn, zoomOut, zoomToFit, escapeTool, goBack, goForward, focusPageInput };
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (!loadedPdf) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const shortcuts = shortcutsRef.current;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === "f") {
        event.preventDefault();
        shortcuts.openSearch();
      } else if (mod && key === "j") {
        event.preventDefault();
        shortcuts.openAsk();
      } else if (mod && key === "o") {
        event.preventDefault();
        shortcuts.openFile();
      } else if (mod && (key === "=" || key === "+")) {
        event.preventDefault();
        shortcuts.zoomIn();
      } else if (mod && key === "-") {
        event.preventDefault();
        shortcuts.zoomOut();
      } else if (mod && key === "0") {
        event.preventDefault();
        shortcuts.zoomToFit();
      } else if (mod && !event.altKey && key === "arrowleft" && !isEditableTarget(event.target)) {
        // As in a browser. (In a text field it keeps moving the cursor.)
        event.preventDefault();
        shortcuts.goBack();
      } else if (mod && !event.altKey && key === "arrowright" && !isEditableTarget(event.target)) {
        event.preventDefault();
        shortcuts.goForward();
      } else if (mod && event.altKey && event.code === "KeyG") {
        // By code: ⌥G types "©" on a Mac keyboard.
        event.preventDefault();
        shortcuts.focusPageInput();
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

  // What a dive request is built from besides the panel (deepdive/
  // diveRequest.ts), read fresh for each request — including which Deep
  // Dive experiments are on.
  const diveRequestContext = (): DiveRequestContext | null => {
    const pdf = pdfDocumentRef.current;
    if (!pdf) return null;
    return {
      pdf,
      pageLabel: pageLabelFor,
      panels: panelsRef.current,
      highlights: highlightsRef.current,
      glossary: glossaryStore.getSnapshot(),
      experiments: getExperiments(),
    };
  };

  // Suggested dives' sources, resolved in the background as soon as an
  // answer suggests them (the suggestions experiment), keyed by the answer's
  // panel and the topic — so opening one doesn't wait on the document's
  // cross-reference and notation scans.
  // Each entry notes what it was resolved for — the inherited passages and
  // the experiment settings — and is used only if those still match.
  const suggestionPrefetchRef = useRef(
    new Map<string, { sources: ReturnType<typeof prepareDiveSources>; stamp: string }>(),
  );
  const prefetchKey = (parentId: string, topic: string) => `${parentId}|${topic.trim().toLowerCase()}`;
  const prefetchStamp = (inherited: SourceRef[] | undefined) =>
    JSON.stringify([inherited?.map((s) => s.chunkId ?? `${s.pageNumber}:${s.start}`), getExperiments()]);

  // Read by Ask jobs when a question is sent.
  const askContextRef = useRef<AskContext | null>(null);
  askContextRef.current =
    pdfDocument && loadedPdf
      ? { pdfDocument, fileName: loadedPdf.fileName, pageLabel: pageLabelFor, pageLabels, currentPage }
      : null;
  const getAskContext = useCallback(() => askContextRef.current, []);

  // Appends the user turn, chooses the document passages this request may
  // cite (grounding/context.ts), streams the reply, and appends it with
  // those sources. A failure appends an inline "⚠️" turn instead of
  // throwing, so the composer never crashes (spec §9).
  const sendDiveMessage = useCallback(
    async (panelId: string, content: string, onChunk?: (chunk: string) => void, options: SendOptions = {}) => {
      if (!loadedPdf) return;
      const panel = panelById(panelsRef.current, panelId);
      if (!panel) return;
      const parentPanel = panel.parentId ? panelById(panelsRef.current, panel.parentId) : null;
      const ctx = diveRequestContext();
      const experiments = ctx?.experiments ?? getExperiments();

      const attachments = options.attachments ?? [];
      const withUserTurn = appendTurn(panel, "user", content, { attachments, diagram: options.diagram });
      setPanels((prev) => replacePanel(prev, withUserTurn));

      // A suggested dive's first request may already be resolved.
      const key = panel.parentId ? prefetchKey(panel.parentId, panel.selection) : null;
      const entry = key && panel.turns.length === 0 && !attachments.length ? suggestionPrefetchRef.current.get(key) : undefined;
      if (key) suggestionPrefetchRef.current.delete(key);
      const prefetched = entry && entry.stamp === prefetchStamp(panel.inheritedSources) ? entry.sources : undefined;
      const prepared = ctx
        ? await (prefetched ?? prepareDiveSources(ctx, panel, content, { reuse: options.reuseSources ?? false, attachments }))
        : undefined;
      const sources = prepared?.sources;
      if (sources) options.onSources?.(sources);
      const attachedLabels =
        attachments.length && sources ? sources.filter((s) => s.via === "attached" || (!s.via && !s.chunkId)).map((s) => s.label) : [];
      const prompt = buildDivePrompt(
        loadedPdf.fileName,
        withUserTurn,
        parentPanel,
        sources
          ? {
              sources,
              pageLabel: pageLabelFor,
              attachmentNote: attachmentInstructions(attachments, attachedLabels, pageLabelFor),
            }
          : undefined,
        ctx ? divePromptOptions(ctx, withUserTurn, sources, { splitAt: prepared?.splitAt, diagram: options.diagram }) : {},
      );

      // The backend is stateless, so each request carries the conversation
      // itself — but only the last two exchanges of it (the selection and
      // its sources are in the system prompt). Earlier answers' citation
      // markers pointed at their own requests' sources, so they're resent
      // as plain page references. An area-highlight's screenshot goes with
      // the first message sent, for the model to keep the visual context.
      const sent = historyTurns(withUserTurn.turns, DIVE_HISTORY_TURNS, experiments.keepOpeningAnswer);
      const images = attachmentImages(attachments);
      const messages = sent.map((turn, index) => ({
        role: turn.role,
        content: turn.role === "assistant" ? markersToPages(turn.content, turn.sources ?? [], pageLabelFor) : turn.content,
        ...(index === 0 && panel.selectionImage ? { image: panel.selectionImage } : {}),
        // Regions added to this question travel with it, not with later ones.
        ...(index === sent.length - 1 && images.length ? { images } : {}),
      }));

      try {
        const full = await streamDiveReply({
          system: prompt.system,
          ...(prompt.suffix ? { systemSuffix: prompt.suffix } : {}),
          messages,
          onText: (chunk) => onChunk?.(chunk),
        });
        // Suggested next steps come at the end of the answer; they're kept
        // apart from its text.
        const { body, suggestions } = experiments.suggestions ? splitSuggestions(full) : { body: full, suggestions: [] };
        const merged = experiments.suggestions && !options.diagram ? mergeSuggestions(suggestions, sources) : [];
        // Nothing to show is a failure, not an (empty) answer with a badge.
        if (!body.trim()) throw new Error("The model returned an empty answer. Try asking again.");
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          const answered = appendTurn(latest, "assistant", body, { sources, suggestions: merged });
          // Stable sources: the first grounded answer's set is what later
          // follow-ups build on.
          const withBase =
            experiments.stableSources && sources && !answered.baseSources ? { ...answered, baseSources: sources } : answered;
          return replacePanel(prev, withBase);
        });
        if (ctx && merged.length) prefetchSuggestedDives(panelId, merged, body, sources);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Dive reply failed.";
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          return replacePanel(prev, appendTurn(latest, "assistant", `⚠️ ${message}`));
        });
      }
    },
    // diveRequestContext and prefetchSuggestedDives read only refs, so
    // they're safe to leave out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loadedPdf, pageLabelFor],
  );

  // Resolves each suggested dive's sources now, locally (no model call),
  // for the first request of the dive it would open.
  const prefetchSuggestedDives = (
    parentId: string,
    suggestions: DiveSuggestion[],
    content: string,
    sources: SourceRef[] | undefined,
  ) => {
    const ctx = diveRequestContext();
    if (!ctx) return;
    const turn = { role: "assistant" as const, content, sources, at: "" };
    for (const suggestion of suggestions) {
      if (suggestion.kind !== "dive") continue;
      const key = prefetchKey(parentId, suggestion.text);
      if (suggestionPrefetchRef.current.has(key)) continue;
      const panel = createNestedPanel({
        parentId,
        selection: suggestion.text,
        contextText: content,
        inheritedSources: suggestedDiveSources(turn, suggestion.sourceLabel),
      });
      const opening = openingMessage(panel.selection);
      suggestionPrefetchRef.current.set(key, {
        sources: prepareDiveSources({ ...ctx, panels: [...ctx.panels, panel] }, panel, opening, { reuse: false, attachments: [] }),
        stamp: prefetchStamp(panel.inheritedSources),
      });
    }
  };

  // `firstMessage` and `attachments` for a dive that opens on a question of
  // its own (see explainXref); otherwise it opens on the selection.
  const createAndOpenDive = useCallback(
    (panel: DivePanel, firstMessage?: string, attachments?: Attachment[]) => {
      // panelsRef is updated synchronously (not via the panels-syncing effect,
      // which hasn't run yet) so the immediate sendDiveMessage call below can
      // find this panel — it looks the panel up through the ref, not state.
      panelsRef.current = [...panelsRef.current, panel];
      setPanels(panelsRef.current);
      setDiveFocusId(panel.id);
      void sendDiveMessage(panel.id, firstMessage ?? openingMessage(panel.selection), undefined, { attachments });
    },
    [sendDiveMessage],
  );

  // A cross-reference's target, shown: flashed when it has a text anchor
  // (a theorem's label, an equation number, a caption), else scrolled to.
  // Either way the place left is remembered for Back.
  const jumpToXref = async (target: XrefTarget) => {
    const pdf = pdfDocumentRef.current;
    if (!pdf) return;
    if (target.range) {
      const page = (await getTextIndex(pdf).catch(() => null))?.pages[target.pageNumber - 1];
      const position = page ? matchPosition({ page, start: target.range[0], end: target.range[1] }) : null;
      if (page && position) {
        flashPassage(`xref-${target.key}`, page.text.slice(target.range[0], target.range[1]), position);
        return;
      }
    }
    rememberPlace(target.pageNumber);
    const viewer = highlighterUtilsRef.current?.getViewer();
    if (!viewer) return;
    viewer.scrollPageIntoView({ pageNumber: target.pageNumber });
    requestAnimationFrame(() => {
      const bounds = getPageVerticalBounds(viewer.container, target.pageNumber);
      if (bounds) viewer.container.scrollTop = bounds.top + target.top * (bounds.bottom - bounds.top) - 24;
    });
  };

  // "Explain the connection": a dive on the sentence the reference is in,
  // with its target added to the question — as an image of it (figures and
  // equations read as printed) plus its text as a source, or a
  // bibliography entry's text.
  const explainXref = async (ref: XrefRef, target: XrefTarget) => {
    const pdf = pdfDocumentRef.current;
    if (!pdf) return;
    const index = await getTextIndex(pdf).catch(() => null);
    const refPage = index?.pages[ref.pageNumber - 1];
    const position = refPage ? matchPosition({ page: refPage, start: ref.start, end: ref.end }) : null;
    if (!refPage || !position) return;
    const [from, to] = sentenceAround(refPage.text, ref.start, ref.end);
    const sentence = refPage.text.slice(from, to).trim();

    let attachment: Attachment | null = null;
    if (target.kind === "citation" && target.entryText) {
      attachment = makeAttachment("document", target.entryText, target.pageNumber);
    } else {
      const targetPage = index?.pages[target.pageNumber - 1] ?? null;
      const crop = parseDataUrlImage((await cropTarget(pdf, target)) ?? undefined);
      if (crop && targetPage) {
        const rect = {
          x1: 0,
          y1: target.top * targetPage.height,
          x2: targetPage.width,
          y2: target.bottom * targetPage.height,
          width: targetPage.width,
          height: targetPage.height,
        };
        attachment = makeRegionAttachment(await downscaleImage(crop), target.pageNumber, targetPage, rect);
      }
    }

    const highlightId = getNextId();
    const panel = createRootPanel({
      anchorHighlightId: highlightId,
      selection: sentence,
      contextText: sentence,
      pageNumber: ref.pageNumber,
    });
    const anchor: CommentedHighlight = {
      id: highlightId,
      type: "text",
      content: { text: ref.text },
      position,
      comment: "",
      divePanelId: panel.id,
      createdAt: new Date().toISOString(),
    };
    setHighlights((previous) => [anchor, ...previous]);
    createAndOpenDive(
      panel,
      `How does ${target.name} (p. ${pageLabelFor(target.pageNumber)}) connect to this passage?`,
      attachment ? [attachment] : undefined,
    );
  };

  const handleDiveDeeper = useCallback(
    async ({ highlight, contextText }: { highlight: GhostHighlight; contextText: string }) => {
      const text = highlight.content.text;
      const parsedImage = parseDataUrlImage(highlight.content.image);
      if (!text && !parsedImage) return;
      const selectionImage = parsedImage ? await downscaleImage(parsedImage) : undefined;
      const highlightId = getNextId();
      const panel = createRootPanel({
        anchorHighlightId: highlightId,
        selection: text ?? "",
        contextText,
        selectionImage,
        pageNumber: highlight.position.boundingRect.pageNumber,
        // Area dives keep their region: the areaContext experiment reads
        // the text in and around it.
        ...(parsedImage ? { region: highlight.position.boundingRect } : {}),
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
    async ({
      highlightId,
      content,
      contextText,
    }: {
      highlightId: string;
      content: GhostHighlight["content"];
      contextText: string;
    }) => {
      const text = content.text;
      const parsedImage = parseDataUrlImage(content.image);
      if (!text && !parsedImage) return;
      const selectionImage = parsedImage ? await downscaleImage(parsedImage) : undefined;
      const panel = createRootPanel({
        anchorHighlightId: highlightId,
        selection: text ?? "",
        contextText,
        selectionImage,
        pageNumber: highlightsRef.current.find((highlight) => highlight.id === highlightId)?.position.boundingRect
          .pageNumber,
      });
      // Not an undoable edit (see undo): it links the highlight to its dive.
      setHighlights((previous) =>
        previous.map((highlight) => (highlight.id === highlightId ? { ...highlight, divePanelId: panel.id } : highlight)),
      );
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  // What a nested dive starts from: the passages the parent answer (the
  // turn the reader selected in) actually cited.
  const inheritedSourcesFrom = (parentId: string, turnIndex: number | undefined): SourceRef[] | undefined => {
    const turn = turnIndex === undefined ? undefined : panelById(panelsRef.current, parentId)?.turns[turnIndex];
    if (!turn?.sources) return undefined;
    const cited = citedSources(turn.content, turn.sources);
    return cited.length ? cited : undefined;
  };

  const handleNestedDive = useCallback(
    ({
      parentId,
      selection,
      contextText,
      turnIndex,
      occurrence,
      inheritedSources,
    }: { parentId: string; selection: string; contextText: string; inheritedSources?: SourceRef[] } & DiveHighlightPlacement) => {
      const panel = createNestedPanel({
        parentId,
        selection,
        contextText,
        inheritedSources: inheritedSources ?? inheritedSourcesFrom(parentId, turnIndex),
      });
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

  // A suggested dive (the suggestions experiment): reopens the dive on that
  // topic if there already is one; otherwise a nested dive hung from the
  // answer that suggested it, inheriting the passage it cited.
  const handleSuggestedDive = useCallback(
    ({ parentId, turnIndex, suggestion }: { parentId: string; turnIndex: number; suggestion: DiveSuggestion }) => {
      const existing = panelsRef.current.find(
        (panel) => panel.parentId === parentId && panel.selection.trim().toLowerCase() === suggestion.text.trim().toLowerCase(),
      );
      if (existing) {
        setDiveFocusId(existing.id);
        return;
      }
      const turn = panelById(panelsRef.current, parentId)?.turns[turnIndex];
      if (!turn) return;
      handleNestedDive({
        parentId,
        selection: suggestion.text,
        contextText: turn.content.slice(0, 1000),
        turnIndex,
        inheritedSources: suggestedDiveSources(turn, suggestion.sourceLabel),
      });
    },
    [handleNestedDive],
  );

  // A one-page summary of a whole dive tree (the treeSummary experiment),
  // streamed through the dive role and kept on the tree's root.
  const summarizeDiveTree = useCallback(
    async (rootId: string, onChunk: (chunk: string) => void, onSources: (sources: SourceRef[]) => void) => {
      if (!loadedPdf) return;
      const { system, prompt, sources } = buildTreeSummaryRequest({
        fileName: loadedPdf.fileName,
        panels: panelsRef.current,
        rootId,
        pageLabel: pageLabelFor,
      });
      onSources(sources);
      const content = await streamDiveReply({ system, messages: [{ role: "user", content: prompt }], onText: onChunk });
      if (!content.trim()) throw new Error("The model returned an empty summary. Try again.");
      const summary = { content, sources, at: new Date().toISOString(), turnCount: treeAnswerCount(panelsRef.current, rootId) };
      setPanels((prev) => prev.map((panel) => (panel.id === rootId ? { ...panel, summary } : panel)));
    },
    [loadedPdf, pageLabelFor],
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
      const panel = createNestedPanel({
        parentId: highlight.panelId,
        selection: highlight.text,
        contextText,
        inheritedSources: inheritedSourcesFrom(highlight.panelId, highlight.turnIndex),
      });
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
    return <LibraryHome storage={getStorage()} onOpen={(meta) => void openFromLibrary(meta)} />;
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
    onAddToQuestion: (content: GhostHighlight["content"], position: ScaledPosition) =>
      void addPdfContentToQuestion(content, position),
    addToQuestionTitle: () =>
      diveFocusIdRef.current ? "Add to this dive's next question" : "Add to your next question (Ask panel)",
    glossary: glossaryBindings,
    xref: {
      pageLabel: pageLabelFor,
      onJump: (target: XrefTarget) => void jumpToXref(target),
      onExplain: (ref: XrefRef, target: XrefTarget) => void explainXref(ref, target),
    },
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
      <input
        ref={openFileInputRef}
        type="file"
        accept="application/pdf,.pdf,application/epub+zip,.epub"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void loadPdfFile(file);
          event.target.value = "";
        }}
      />
      <AppRail
        onHome={() => void goHome()}
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
          footer:
            loadedPdf?.sourceUrl || SHOW_EXPORT_BUTTON ? (
              <>
                <div className="rail-popover-separator" />
                {loadedPdf?.sourceUrl ? (
                  <button
                    type="button"
                    className="view-menu-action"
                    onClick={() => void openExternal(loadedPdf.sourceUrl!)}
                    title={loadedPdf.sourceUrl}
                  >
                    Open original page
                  </button>
                ) : null}
                {SHOW_EXPORT_BUTTON ? (
                  <button type="button" className="view-menu-action" onClick={handleExport} disabled={exporting}>
                    {exporting ? "Exporting…" : "Export PDF"}
                  </button>
                ) : null}
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
            onSuggestedDive={handleSuggestedDive}
            onSummarizeTree={summarizeDiveTree}
            pageLabel={pageLabelFor}
            onJumpToSource={jumpToSource}
            attachments={diveAttachments}
            onAddToQuestion={(divePanelId, kind, text, pageNumber) => addToQuestion(kind, text, pageNumber, divePanelId)}
            onRemoveAttachment={(divePanelId, id) =>
              setDiveAttachments((all) => ({ ...all, [divePanelId]: (all[divePanelId] ?? []).filter((a) => a.id !== id) }))
            }
            onClearAttachments={(divePanelId) => setDiveAttachments((all) => ({ ...all, [divePanelId]: [] }))}
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
              askStore={askStore}
              getAskContext={getAskContext}
              openAskThreadId={openAskThreadId}
              onOpenAskThread={setOpenAskThreadId}
              askFocusRequest={askFocusRequest}
              onJumpToSource={jumpToSource}
              askAttachments={askAttachments}
              onAddToAsk={(kind, text) => addToQuestion(kind, text)}
              onRemoveAskAttachment={(id) => setAskAttachments((list) => list.filter((a) => a.id !== id))}
              onClearAskAttachments={() => setAskAttachments([])}
              onPin={handlePin}
            />

            <main className="viewer">
              <div className="pdf-pane-slot" ref={workspaceSlotRef} />
            </main>
          </div>
        )}
      </div>

      <PersistentPdfPane
        key={loadedPdf.docId}
        pdfPaneProps={pdfPaneProps}
        dockTarget={dockTarget}
        workspaceSlotRef={workspaceSlotRef}
        deepDiveRootSlotRef={deepDiveRootSlotRef}
        highlighterUtilsRef={highlighterUtilsRef}
        overlay={
          pdfDocument ? (
            <PageNavigator
              currentPage={currentPage}
              numPages={pdfDocument.numPages}
              pageLabels={pageLabels}
              twoPageView={twoPageView}
              back={navHistory.backList()}
              forward={navHistory.forwardList()}
              onBack={goBack}
              onForward={goForward}
              onPreviousPage={previousPage}
              onNextPage={nextPage}
              onGoToPage={goToPage}
              focusRequest={pageInputFocusRequest}
            />
          ) : null
        }
      />
    </div>
  );
}
