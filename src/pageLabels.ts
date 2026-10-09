// PDFs can declare custom page labels (e.g. roman numerals "i"–"xii" for
// front matter, then "1", "2", ... for the body) via a /PageLabels entry.
// pdf.js's getPageLabels() returns them 0-indexed and parallel to pages, or
// null when the PDF declares none — in which case the plain page number is
// the correct label anyway.
export function formatPageLabel(pageLabels: string[] | null, pageNumber: number): string {
  return pageLabels?.[pageNumber - 1] ?? String(pageNumber);
}

// The page a typed "go to page" entry means. The book's own label comes
// first, since that's the number the reader sees printed, cited and listed in
// the contents (in a book whose "1" is the PDF's 15th page, "45" is the page
// printed 45); failing that, a plain number counts pages from the start of
// the PDF. Null when it names no page.
export function pageNumberForInput(pageLabels: string[] | null, input: string, numPages: number): number | null {
  const wanted = input.trim().toLowerCase();
  if (!wanted) return null;
  const labelIndex = pageLabels?.findIndex((label) => label.trim().toLowerCase() === wanted) ?? -1;
  if (labelIndex >= 0 && labelIndex < numPages) return labelIndex + 1;
  if (!/^\d+$/.test(wanted)) return null;
  const pageNumber = Number(wanted);
  return pageNumber >= 1 && pageNumber <= numPages ? pageNumber : null;
}
