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
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
// react-pdf-highlighter-plus only ships *overrides* on top of PDF.js's own
// viewer stylesheet (see its style/pdf_viewer.css header comment). Without
// the base stylesheet, the text layer spans lack `position: absolute` and
// text selection over the PDF is broken.
import "pdfjs-dist/web/pdf_viewer.css";
import "react-pdf-highlighter-plus/style/style.css";
import type { PDFDocumentProxy } from "pdfjs-dist";
import Sidebar, { type SidebarPanel } from "./components/Sidebar";
import SearchBar, { SearchToggleButton } from "./components/SearchBar";
import type { CommentedHighlight } from "./types";
import "./App.css";
import PdfPane from "./deepdive/PdfPane";
import DeepDiveView from "./deepdive/DeepDiveView";
import type { DivePanel, Pin } from "./deepdive/types";
import {
  appendTurn,
  createNestedPanel,
  createRootPanel,
  panelById,
  replacePanel,
} from "./deepdive/tree";
import {
  divesKeyForFile,
  loadDivePanels,
  loadPins,
  pinsKeyForFile,
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
}

const getNextId = () => crypto.randomUUID();

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
        <h1>PDF Highlighter</h1>
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
  const [diveFocusId, setDiveFocusId] = useState<string | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [freetextMode, setFreetextMode] = useState(false);
  const [scrolledToHighlightId, setScrolledToHighlightId] = useState<string | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // PdfPane remounts a fresh PdfHighlighter whenever the app switches between
  // the normal layout and the Deep Dive split view; this is threaded through
  // as `initialPage` so each remount reopens on the page the user was
  // actually reading instead of resetting to page 1.
  const [currentPage, setCurrentPage] = useState(1);
  const [activeSidebarPanel, setActiveSidebarPanel] = useState<SidebarPanel | null>(
    "toc",
  );
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelsRef = useRef<DivePanel[]>([]);

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [loadedPdf]);

  const loadPdfFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const arrayBuffer = event.target?.result;
      if (!(arrayBuffer instanceof ArrayBuffer)) return;

      const storageKey = storageKeyForFile(file);
      const divesKey = divesKeyForFile(file);
      const pinsKey = pinsKeyForFile(file);
      setLoadedPdf({
        source: new Uint8Array(arrayBuffer),
        fileName: file.name,
        storageKey,
        divesKey,
        pinsKey,
      });
      setHighlights(loadHighlights(storageKey));
      setPanels(loadDivePanels(divesKey));
      setPins(loadPins(pinsKey));
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

  const resetViewer = () => {
    setLoadedPdf(null);
    setHighlights([]);
    setPanels([]);
    setPins([]);
    setDiveFocusId(null);
    setAreaMode(false);
    setFreetextMode(false);
    setScrolledToHighlightId(null);
    setCurrentPage(1);
    setPdfDocument(null);
  };

  const addHighlight = (highlight: GhostHighlight, comment: string) => {
    const next: CommentedHighlight = {
      ...highlight,
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

  const deleteHighlight = (highlightId: string) => {
    setHighlights((previous) =>
      previous.filter((highlight) => highlight.id !== highlightId),
    );
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

  const handleDeletePin = (pinId: string) => {
    setPins((previous) => previous.filter((pin) => pin.id !== pinId));
  };

  const handleOpenDive = (divePanelId: string) => {
    setDiveFocusId(divePanelId);
  };

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
    onPin: handlePin,
    initialPage: currentPage,
    onPageChange: setCurrentPage,
    onDocumentReady: setPdfDocument,
  };

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div className="toolbar-group">
          <strong className="toolbar-title">{loadedPdf.fileName}</strong>
        </div>
        <div className="toolbar-group toolbar-actions">
          {searchOpen ? (
            <SearchBar utilsRef={highlighterUtilsRef} onClose={() => setSearchOpen(false)} />
          ) : (
            <SearchToggleButton onClick={() => setSearchOpen(true)} />
          )}
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
          focusId={diveFocusId}
          rootLabel={loadedPdf.fileName}
          onFocusChange={setDiveFocusId}
          pdfPaneProps={pdfPaneProps}
          onSendMessage={sendDiveMessage}
          onNestedDive={handleNestedDive}
          onPin={handlePin}
        />
      ) : (
        <div className="workspace">
          <Sidebar
            highlights={highlights}
            pins={pins}
            fileName={loadedPdf.fileName}
            scrolledToHighlightId={scrolledToHighlightId}
            onJumpToHighlight={jumpToHighlight}
            onDeleteHighlight={(highlight) => deleteHighlight(highlight.id)}
            onClearHighlights={() => setHighlights([])}
            onOpenDive={handleOpenDive}
            onDeletePin={handleDeletePin}
            onUploadNew={resetViewer}
            activePanel={activeSidebarPanel}
            onSelectPanel={handleSelectSidebarPanel}
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            onGoToPage={goToPage}
          />

          <main className="viewer">
            <PdfPane {...pdfPaneProps} />
          </main>
        </div>
      )}
    </div>
  );
}
