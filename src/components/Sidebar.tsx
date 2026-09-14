import type { ReactNode } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CommentedHighlight } from "../types";
import type { DiveHighlight, DivePanel, Pin } from "../deepdive/types";
import AnnotationsPanel from "./AnnotationsPanel";
import TableOfContentsPanel from "./TableOfContentsPanel";

export type SidebarPanel = "annotations" | "toc";

interface SidebarProps {
  highlights: CommentedHighlight[];
  pins: Pin[];
  panels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToHighlightId: string | null;
  onJumpToHighlight: (highlight: CommentedHighlight) => void;
  onDeleteHighlight: (highlight: CommentedHighlight) => void;
  onOpenDiveFromHighlight: (highlight: CommentedHighlight) => void;
  onDeletePin: (pinId: string) => void;
  onOpenDiveHighlight: (highlight: DiveHighlight) => void;
  onDeleteDiveHighlight: (highlightId: string) => void;
  activePanel: SidebarPanel | null;
  onSelectPanel: (panel: SidebarPanel) => void;
  pdfDocument: PDFDocumentProxy | null;
  pageLabels: string[] | null;
  currentPage: number;
  onGoToPage: (pageNumber: number) => void;
}

function AnnotationsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12v18l-6-4-6 4V3z" />
    </svg>
  );
}

function TocIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="14" y2="18" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === "left" ? "15 6 9 12 15 18" : "9 6 15 12 9 18"} />
    </svg>
  );
}

const RAIL_ITEMS: { id: SidebarPanel; label: string; icon: ReactNode }[] = [
  { id: "toc", label: "Table of contents", icon: <TocIcon /> },
  { id: "annotations", label: "Annotations", icon: <AnnotationsIcon /> },
];

export default function Sidebar({
  highlights,
  pins,
  panels,
  diveHighlights,
  scrolledToHighlightId,
  onJumpToHighlight,
  onDeleteHighlight,
  onOpenDiveFromHighlight,
  onDeletePin,
  onOpenDiveHighlight,
  onDeleteDiveHighlight,
  activePanel,
  onSelectPanel,
  pdfDocument,
  pageLabels,
  currentPage,
  onGoToPage,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-rail">
        {RAIL_ITEMS.map(({ id, label, icon }) => (
          <button
            key={id}
            type="button"
            className={`sidebar-rail-button${activePanel === id ? " active" : ""}`}
            onClick={() => onSelectPanel(id)}
            title={label}
            aria-label={label}
            aria-pressed={activePanel === id}
          >
            {icon}
          </button>
        ))}
      </nav>

      {activePanel ? (
        <div className="sidebar-panel">
          <button
            type="button"
            className="sidebar-collapse-button"
            onClick={() => onSelectPanel(activePanel)}
            title="Collapse panel"
            aria-label="Collapse panel"
          >
            <ChevronIcon direction="left" />
          </button>
          {activePanel === "annotations" ? (
            <AnnotationsPanel
              highlights={highlights}
              pins={pins}
              panels={panels}
              diveHighlights={diveHighlights}
              scrolledToHighlightId={scrolledToHighlightId}
              onJumpToHighlight={onJumpToHighlight}
              onDeleteHighlight={onDeleteHighlight}
              onOpenDiveFromHighlight={onOpenDiveFromHighlight}
              onDeletePin={onDeletePin}
              onOpenDiveHighlight={onOpenDiveHighlight}
              onDeleteDiveHighlight={onDeleteDiveHighlight}
              pageLabels={pageLabels}
              pdfDocument={pdfDocument}
              currentPage={currentPage}
            />
          ) : (
            <TableOfContentsPanel
              pdfDocument={pdfDocument}
              currentPage={currentPage}
              goToPage={onGoToPage}
              pageLabels={pageLabels}
            />
          )}
        </div>
      ) : null}
    </aside>
  );
}
