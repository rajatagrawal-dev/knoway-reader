import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useDocumentOutline, type ProcessedOutlineItem } from "react-pdf-highlighter-plus";
import { formatPageLabel } from "../pageLabels";

interface TableOfContentsPanelProps {
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
  goToPage: (pageNumber: number) => void;
  pageLabels: string[] | null;
}

export default function TableOfContentsPanel({
  pdfDocument,
  currentPage,
  goToPage,
  pageLabels,
}: TableOfContentsPanelProps) {
  return (
    <>
      <header className="sidebar-header">
        <h2>Table of contents</h2>
      </header>
      <div className="sidebar-list toc-list">
        {pdfDocument ? (
          <TableOfContentsOutline
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            goToPage={goToPage}
            pageLabels={pageLabels}
          />
        ) : (
          <p className="sidebar-empty">Loading document…</p>
        )}
      </div>
    </>
  );
}

// useDocumentOutline requires a non-null document, so this only mounts once
// PdfPane has reported one via onDocumentReady.
function TableOfContentsOutline({
  pdfDocument,
  currentPage,
  goToPage,
  pageLabels,
}: {
  pdfDocument: PDFDocumentProxy;
  currentPage: number;
  goToPage: (pageNumber: number) => void;
  pageLabels: string[] | null;
}) {
  const { outline, isLoading, navigateToItem, flatOutline } = useDocumentOutline({
    pdfDocument,
    goToPage,
  });

  // The default active-item logic only marks an item active when currentPage
  // matches its pageNumber exactly, so a multi-page section goes dark past
  // its first page. flatOutline is in document order, so the section
  // actually being read is the last item whose page has been reached;
  // feeding its pageNumber back in as "currentPage" highlights that section
  // for every page within it, until the next section's start page.
  const activePageNumber = flatOutline.reduce((active, item) => {
    if (item.pageNumber <= currentPage && item.pageNumber > active) {
      return item.pageNumber;
    }
    return active;
  }, 0);

  if (isLoading) {
    return <p className="sidebar-empty">Loading outline…</p>;
  }

  if (!outline || outline.length === 0) {
    return <p className="sidebar-empty">No outline available</p>;
  }

  return (
    <div className="toc-outline">
      {outline.map((item) => (
        <TocOutlineItem
          key={item.id}
          item={item}
          currentPage={activePageNumber || currentPage}
          pageLabels={pageLabels}
          onNavigate={navigateToItem}
        />
      ))}
    </div>
  );
}

// react-pdf-highlighter-plus's own <DocumentOutline> always renders the raw
// pdf.js page number, with no hook to substitute a label — its renderItem
// prop replaces an item's children/expand-collapse chrome entirely rather
// than just the number, so a small local reimplementation (mirroring its
// look) is what lets front-matter pages show their real "i"/"ii"/"iii".
function TocOutlineItem({
  item,
  currentPage,
  pageLabels,
  onNavigate,
}: {
  item: ProcessedOutlineItem;
  currentPage: number;
  pageLabels: string[] | null;
  onNavigate: (item: ProcessedOutlineItem) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = item.children.length > 0;
  const isActive = currentPage === item.pageNumber;

  return (
    <div className="toc-item">
      <div
        className={`toc-item-row${isActive ? " toc-item-row--active" : ""}`}
        style={{ paddingLeft: 12 + item.level * 16 }}
        role="button"
        tabIndex={0}
        onClick={() => onNavigate(item)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onNavigate(item);
          }
        }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="toc-item-expand"
            aria-label={expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
          >
            {expanded ? <ChevronDown width={12} height={12} /> : <ChevronRight width={12} height={12} />}
          </button>
        ) : (
          <span className="toc-item-expand-spacer" />
        )}
        <span
          className={`toc-item-title${item.bold ? " toc-item-title--bold" : ""}${
            item.italic ? " toc-item-title--italic" : ""
          }`}
          title={item.title}
        >
          {item.title}
        </span>
        <span className="toc-item-page">{formatPageLabel(pageLabels, item.pageNumber)}</span>
      </div>
      {hasChildren && expanded ? (
        <div className="toc-item-children">
          {item.children.map((child) => (
            <TocOutlineItem
              key={child.id}
              item={child}
              currentPage={currentPage}
              pageLabels={pageLabels}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
