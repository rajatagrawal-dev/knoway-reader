// PDFs can declare custom page labels (e.g. roman numerals "i"–"xii" for
// front matter, then "1", "2", ... for the body) via a /PageLabels entry.
// pdf.js's getPageLabels() returns them 0-indexed and parallel to pages, or
// null when the PDF declares none — in which case the plain page number is
// the correct label anyway.
export function formatPageLabel(pageLabels: string[] | null, pageNumber: number): string {
  return pageLabels?.[pageNumber - 1] ?? String(pageNumber);
}
