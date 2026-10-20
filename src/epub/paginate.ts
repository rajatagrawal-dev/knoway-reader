// Cutting one laid-out chapter — a single tall column, in CSS pixels from its
// top — into pages. A page ends where the next line or picture would cross
// its bottom, so nothing is ever cut in half; the book's own page breaks
// ("page-break-before: always" on a chapter title) start a new page; and a
// heading left alone at the foot of a page moves over to the next one with
// the text it introduces. Pure, so it's unit-tested.

export interface Placed {
  top: number;
  bottom: number;
  keepWithNext?: boolean; // a heading's line: don't end a page on it
}

const EPSILON = 0.5;

// The y at which each page starts. A chapter with nothing on it has no pages.
export function paginate(items: Placed[], pageHeight: number, forcedBreaks: number[] = []): number[] {
  const sorted = [...items].filter((item) => item.bottom > item.top).sort((a, b) => a.top - b.top);
  if (sorted.length === 0) return [];
  const breaks = [...new Set(forcedBreaks)].sort((a, b) => a - b);
  const contentEnd = Math.max(...sorted.map((item) => item.bottom));
  const pages: number[] = [];
  let start = Math.min(0, sorted[0].top);
  while (start < contentEnd - EPSILON) {
    pages.push(start);
    const limit = start + pageHeight;
    // A break with nothing above it on this page would only leave it empty.
    const forced = breaks.find(
      (y) =>
        y > start + EPSILON &&
        sorted.some((item) => item.top >= start - EPSILON && item.top < y - EPSILON) &&
        sorted.some((item) => item.top >= y - EPSILON),
    );
    let next: number;
    if (forced !== undefined && forced <= limit) {
      next = forced;
    } else {
      next = limit;
      for (const item of sorted) {
        if (item.top >= limit) break;
        if (item.top > start + EPSILON && item.bottom > limit + EPSILON) next = Math.min(next, item.top);
      }
      // A heading at the page's foot: start the next page with it instead,
      // unless that would leave this page empty.
      const onPage = sorted.filter((item) => item.top >= start - EPSILON && item.top < next - EPSILON);
      const continues = sorted.some((item) => item.top >= next - EPSILON);
      if (continues && onPage.length > 0) {
        const lastBottom = Math.max(...onPage.map((item) => item.bottom));
        const trailing = onPage.filter((item) => item.bottom > lastBottom - EPSILON);
        if (trailing.every((item) => item.keepWithNext)) {
          let cut = Math.min(...trailing.map((item) => item.top));
          // The whole heading, if it runs over several lines.
          for (let i = onPage.length - 1; i >= 0; i -= 1) {
            const item = onPage[i];
            if (!item.keepWithNext || item.bottom < cut - pageHeight * 0.05) break;
            cut = Math.min(cut, item.top);
          }
          if (cut > start + EPSILON) next = cut;
        }
      }
    }
    const following = sorted.find((item) => item.top >= next - EPSILON);
    if (!following) break;
    // A page opens with its first line, not the gap left above it — except
    // after a forced break, where the space above the element is the book's.
    start = forced !== undefined && next === forced ? next : Math.max(next - EPSILON, following.top);
  }
  return pages;
}

// Which page (index into `pages`) an element starting at `top` falls on.
export function pageAt(pages: number[], top: number): number {
  let index = 0;
  for (let i = 0; i < pages.length; i += 1) if (pages[i] <= top + EPSILON) index = i;
  return index;
}
