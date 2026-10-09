import { matchPosition, type IndexedPage, type TermMatch } from "../glossary/textIndex";

// Where a span of a page's text is drawn, as boxes in fractions of the page
// — for marks laid over the PDF (glossary terms, cross-references) that stay
// put when the page is zoomed.

export interface Box {
  left: number; // fractions of the page's width/height
  top: number;
  width: number;
  height: number;
}

// pdf.js's text layer has one span per text run, in the same order as the
// runs the index was built from (minus the ones it dropped, e.g. running
// heads) — pair each indexed run with its span's text node.
export function runTextNodes(pageDiv: HTMLElement, page: IndexedPage): (Text | null)[] {
  const spans = [...pageDiv.querySelectorAll<HTMLElement>(".textLayer span")].filter((span) => !span.firstElementChild);
  let next = 0;
  return page.items.map((item) => {
    for (let k = next; k < Math.min(spans.length, next + 40); k += 1) {
      if (spans[k].textContent === item.text) {
        next = k + 1;
        const node = spans[k].firstChild;
        return node instanceof Text ? node : null;
      }
    }
    return null;
  });
}

// Where the matched characters are drawn, measured from the text layer —
// the same geometry the browser uses to paint a selection of them. The
// index's own rects only interpolate across a run by character count,
// which drifts by a character or two within a long run of proportional
// text. Null if any run's span can't be found.
export function measureBoxes(match: TermMatch, nodes: (Text | null)[], pageRect: DOMRect): Box[] | null {
  const { page } = match;
  const spans = new Map<number, [number, number]>();
  for (let i = match.start; i < match.end; i += 1) {
    const run = page.charItem[i];
    if (run < 0) continue;
    const offset = page.charOffset[i];
    const span = spans.get(run);
    if (!span) spans.set(run, [offset, offset + 1]);
    else span[1] = Math.max(span[1], offset + 1);
  }
  const boxes: Box[] = [];
  const range = document.createRange();
  for (const [run, [from, to]] of spans) {
    const node = nodes[run];
    if (!node || to > node.length) return null;
    range.setStart(node, from);
    range.setEnd(node, to);
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      boxes.push({
        left: (rect.left - pageRect.left) / pageRect.width,
        top: (rect.top - pageRect.top) / pageRect.height,
        width: rect.width / pageRect.width,
        height: rect.height / pageRect.height,
      });
    }
  }
  return boxes.length > 0 ? boxes : null;
}

// Fallback when the text layer can't be measured: the index's own rects.
export function estimateBoxes(match: TermMatch): Box[] {
  const position = matchPosition(match);
  return (position?.rects ?? []).map((r) => ({
    left: r.x1 / r.width,
    top: r.y1 / r.height,
    width: (r.x2 - r.x1) / r.width,
    height: (r.y2 - r.y1) / r.height,
  }));
}
