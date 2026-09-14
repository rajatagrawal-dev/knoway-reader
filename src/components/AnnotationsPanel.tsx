import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Funnel } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useDocumentOutline } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import type { DiveHighlight, DivePanel, Pin } from "../deepdive/types";
import { panelById } from "../deepdive/tree";
import { formatPageLabel } from "../pageLabels";

interface AnnotationsPanelProps {
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
  pageLabels: string[] | null;
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
}

type FilterKey = "main-text" | "deep-dives" | "pins" | "notes" | "current-chapter";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "main-text", label: "Main text" },
  { key: "deep-dives", label: "Deep dives" },
  { key: "pins", label: "Pins" },
  { key: "notes", label: "Notes" },
  { key: "current-chapter", label: "Current chapter" },
];

type AnnotationKind = "highlight" | "pin" | "dive";

interface AnnotationRow {
  id: string;
  kind: AnnotationKind;
  badge: string;
  pageNumber?: number;
  text: string;
  comment?: string;
  isActive: boolean;
  onOpen?: () => void;
  onDelete: () => void;
  diveBadge?: { label: string; onClick: () => void };
}

// A single "Filters" button opening a checkbox dropdown, rather than an
// always-visible chip row — checking/unchecking a box applies immediately
// (no separate Apply step) via onToggleFilter, same as the chips did.
function FiltersDropdown({
  activeFilters,
  onToggleFilter,
  chapterFilterAvailable,
}: {
  activeFilters: Set<FilterKey>;
  onToggleFilter: (key: FilterKey) => void;
  chapterFilterAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  return (
    <div className="annotations-filters" ref={containerRef}>
      <button
        type="button"
        className={`annotations-filters-toggle${activeFilters.size > 0 ? " active" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Funnel width={14} height={14} strokeWidth={2.5} />
        Filters{activeFilters.size > 0 ? ` (${activeFilters.size})` : ""}
        <ChevronDown className="annotations-filters-chevron" width={14} height={14} strokeWidth={2.5} />
      </button>
      {open ? (
        <div className="annotations-filters-menu" role="menu">
          {FILTERS.map(({ key, label }) => {
            const disabled = key === "current-chapter" && !chapterFilterAvailable;
            return (
              <label key={key} className={`annotations-filters-menu-item${disabled ? " disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={activeFilters.has(key)}
                  disabled={disabled}
                  onChange={() => onToggleFilter(key)}
                />
                <span>{label}</span>
              </label>
            );
          })}
          {activeFilters.size > 0 ? (
            <>
              <div className="annotations-filters-menu-divider" />
              <button
                type="button"
                className="annotations-filters-menu-clear"
                onClick={() => activeFilters.forEach((key) => onToggleFilter(key))}
              >
                Clear filters
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function highlightLabel(highlight: CommentedHighlight): string {
  if (highlight.content?.text) return highlight.content.text;
  if (highlight.type === "freetext") return "Sticky note";
  if (highlight.type === "area") return "Area highlight";
  return "Highlight";
}

// Finds the top-level chapter currentPage falls in and returns its page
// range [start, end] (end is the page before the next chapter starts, or
// +Infinity for the last chapter) — the basis for the "Current chapter"
// filter. flatOutline flattens every level of the outline (chapters *and*
// their nested subsections) into one document-ordered list, so it's first
// narrowed down to just the top-level entries (the lowest `level` present)
// — otherwise the "active" entry and its boundary would often be a
// subsection rather than its parent chapter, making this filter behave
// like "current section" instead.
function chapterRangeForPage(
  flatOutline: { pageNumber: number; level: number }[] | undefined,
  currentPage: number,
): [number, number] | null {
  if (!flatOutline || flatOutline.length === 0) return null;
  const minLevel = Math.min(...flatOutline.map((item) => item.level));
  const chapters = flatOutline.filter((item) => item.level === minLevel);
  if (chapters.length === 0) return null;
  let activeIndex = -1;
  chapters.forEach((item, index) => {
    if (item.pageNumber <= currentPage) activeIndex = index;
  });
  if (activeIndex === -1) return [1, chapters[0].pageNumber - 1];
  const start = chapters[activeIndex].pageNumber;
  const next = chapters[activeIndex + 1];
  const end = next ? next.pageNumber - 1 : Number.POSITIVE_INFINITY;
  return [start, end];
}

export default function AnnotationsPanel(props: AnnotationsPanelProps) {
  // useDocumentOutline requires a non-null document, so the chapter-range
  // lookup only mounts (and only runs its hook) once PdfPane has reported
  // one via onDocumentReady — mirrors TableOfContentsPanel's own split for
  // the same reason.
  return props.pdfDocument ? (
    <AnnotationsPanelWithOutline {...props} pdfDocument={props.pdfDocument} />
  ) : (
    <AnnotationsPanelBody {...props} chapterRange={null} />
  );
}

function AnnotationsPanelWithOutline(props: AnnotationsPanelProps & { pdfDocument: PDFDocumentProxy }) {
  const { flatOutline } = useDocumentOutline({ pdfDocument: props.pdfDocument });
  const chapterRange = useMemo(
    () => chapterRangeForPage(flatOutline, props.currentPage),
    [flatOutline, props.currentPage],
  );
  return <AnnotationsPanelBody {...props} chapterRange={chapterRange} />;
}

function AnnotationsPanelBody({
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
  pageLabels,
  chapterRange,
}: AnnotationsPanelProps & { chapterRange: [number, number] | null }) {
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set());

  const toggleFilter = (key: FilterKey) => {
    setActiveFilters((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const rows: AnnotationRow[] = useMemo(() => {
    const highlightRows: AnnotationRow[] = highlights.map((highlight) => ({
      id: highlight.id,
      kind: "highlight",
      badge: highlight.type ?? "highlight",
      pageNumber: highlight.position.boundingRect.pageNumber,
      text: highlightLabel(highlight),
      comment: highlight.comment,
      isActive: scrolledToHighlightId === highlight.id,
      onOpen: () => onJumpToHighlight(highlight),
      onDelete: () => onDeleteHighlight(highlight),
      diveBadge: highlight.divePanelId
        ? { label: "Dive ↗", onClick: () => onOpenDiveFromHighlight(highlight) }
        : undefined,
    }));

    const diveRows: AnnotationRow[] = diveHighlights.map((highlight) => ({
      id: highlight.id,
      kind: "dive",
      badge: panelById(panels, highlight.panelId)?.label ?? "Dive",
      text: highlight.text,
      comment: highlight.comment,
      isActive: scrolledToHighlightId === highlight.id,
      onOpen: () => onOpenDiveHighlight(highlight),
      onDelete: () => onDeleteDiveHighlight(highlight.id),
    }));

    const pinRows: AnnotationRow[] = pins.map((pin) => ({
      id: pin.id,
      kind: "pin",
      badge: "Pin",
      text: pin.text,
      isActive: false,
      onDelete: () => onDeletePin(pin.id),
    }));

    return [...highlightRows, ...diveRows, ...pinRows];
  }, [
    highlights,
    diveHighlights,
    pins,
    panels,
    scrolledToHighlightId,
    onJumpToHighlight,
    onDeleteHighlight,
    onOpenDiveFromHighlight,
    onOpenDiveHighlight,
    onDeleteDiveHighlight,
    onDeletePin,
  ]);

  // Every active filter must pass (AND, not OR) — e.g. "Deep dives" +
  // "Notes" together means "dive highlights that have a note attached."
  const filteredRows = useMemo(() => {
    if (activeFilters.size === 0) return rows;
    return rows.filter((row) => {
      if (activeFilters.has("main-text") && row.kind !== "highlight") return false;
      if (activeFilters.has("deep-dives") && row.kind !== "dive") return false;
      if (activeFilters.has("pins") && row.kind !== "pin") return false;
      if (activeFilters.has("notes") && !row.comment) return false;
      if (activeFilters.has("current-chapter")) {
        if (row.pageNumber == null || !chapterRange) return false;
        if (row.pageNumber < chapterRange[0] || row.pageNumber > chapterRange[1]) return false;
      }
      return true;
    });
  }, [rows, activeFilters, chapterRange]);

  return (
    <>
      <header className="sidebar-header">
        <h2>Annotations</h2>
        <p className="sidebar-count">
          {activeFilters.size > 0 ? `${filteredRows.length} of ${rows.length}` : rows.length} annotation
          {rows.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="annotations-filter-bar">
        <FiltersDropdown
          activeFilters={activeFilters}
          onToggleFilter={toggleFilter}
          chapterFilterAvailable={Boolean(chapterRange)}
        />
      </div>

      <div className="sidebar-list">
        {rows.length === 0 ? (
          <div className="sidebar-empty">
            <p>No annotations yet</p>
            <p className="sidebar-hint">
              Select text to highlight, hold Alt and drag for area highlights, use Note mode for sticky
              notes, or highlight and pin text inside a dive.
            </p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="sidebar-empty">
            <p>No annotations match the selected filters</p>
          </div>
        ) : (
          filteredRows.map((row) => {
            const content = (
              <>
                <span className="sidebar-item-type-row">
                  <span className="sidebar-item-type">{row.badge}</span>
                  {row.diveBadge ? (
                    <button
                      type="button"
                      className="dive-badge"
                      title="Open this dive"
                      onClick={(event) => {
                        event.stopPropagation();
                        row.diveBadge!.onClick();
                      }}
                    >
                      {row.diveBadge.label}
                    </button>
                  ) : null}
                </span>
                {row.pageNumber != null ? (
                  <span className="sidebar-item-page">Page {formatPageLabel(pageLabels, row.pageNumber)}</span>
                ) : null}
                <span className="sidebar-item-text">{row.text}</span>
                {row.comment ? <span className="sidebar-item-comment">{row.comment}</span> : null}
              </>
            );

            return (
              <article key={`${row.kind}-${row.id}`} className={`sidebar-item${row.isActive ? " is-active" : ""}`}>
                {row.onOpen ? (
                  <div
                    role="button"
                    tabIndex={0}
                    className="sidebar-item-main"
                    onClick={row.onOpen}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        row.onOpen!();
                      }
                    }}
                  >
                    {content}
                  </div>
                ) : (
                  <div className="sidebar-item-main sidebar-item-main--static">{content}</div>
                )}
                <button type="button" className="sidebar-item-delete" title="Delete annotation" onClick={row.onDelete}>
                  Delete
                </button>
              </article>
            );
          })
        )}
      </div>
    </>
  );
}
