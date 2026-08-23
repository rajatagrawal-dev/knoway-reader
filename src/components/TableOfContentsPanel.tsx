import type { PDFDocumentProxy } from "pdfjs-dist";
import { DocumentOutline, useDocumentOutline } from "react-pdf-highlighter-plus";

interface TableOfContentsPanelProps {
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
  goToPage: (pageNumber: number) => void;
}

export default function TableOfContentsPanel({
  pdfDocument,
  currentPage,
  goToPage,
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
}: {
  pdfDocument: PDFDocumentProxy;
  currentPage: number;
  goToPage: (pageNumber: number) => void;
}) {
  const { outline, isLoading, navigateToItem, flatOutline } = useDocumentOutline({
    pdfDocument,
    goToPage,
  });

  // DocumentOutline only marks an item active when currentPage matches its
  // pageNumber exactly, so a 5-page section goes dark past its first page.
  // flatOutline is in document order, so the section actually being read is
  // the last item whose page has been reached; feeding its pageNumber back
  // in as "currentPage" makes the library highlight that section for every
  // page within it, until the next section's start page is reached.
  const activePageNumber = flatOutline.reduce((active, item) => {
    if (item.pageNumber <= currentPage && item.pageNumber > active) {
      return item.pageNumber;
    }
    return active;
  }, 0);

  return (
    <DocumentOutline
      outline={outline}
      isLoading={isLoading}
      currentPage={activePageNumber || currentPage}
      onNavigate={navigateToItem}
      className="toc-outline"
    />
  );
}
