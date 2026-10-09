// The document's section structure, from its PDF outline (bookmarks):
// which section a page is in ("3 Entanglement › 3.2 Bell states"), and
// which pages a section spans. Used to tag sources for the model and to
// scope a question to "this chapter". A PDF without an outline simply has
// no sections.

export interface Section {
  title: string;
  depth: number; // 0 for top-level entries
  pageNumber: number; // 1-based page the section starts on
}

// The minimal slice of PDFDocumentProxy this module needs, so the pure
// parts are testable without pdf.js.
export interface OutlineSource {
  numPages: number;
  getOutline(): Promise<OutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

export interface OutlineNode {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineNode[];
}

async function destinationPage(source: OutlineSource, dest: OutlineNode["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await source.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (target === undefined || target === null) return null;
    // A destination names its page by reference, or (rarely) by 0-based index.
    const index = typeof target === "number" ? target : await source.getPageIndex(target);
    return index >= 0 && index < source.numPages ? index + 1 : null;
  } catch {
    return null;
  }
}

// The outline flattened in document order. Entries whose destination can't
// be resolved (external links, broken bookmarks) are left out, but their
// children are kept.
export async function buildSections(source: OutlineSource): Promise<Section[]> {
  const outline = await source.getOutline().catch(() => null);
  if (!outline) return [];
  const sections: Section[] = [];
  const visit = async (nodes: OutlineNode[], depth: number) => {
    for (const node of nodes) {
      const pageNumber = await destinationPage(source, node.dest);
      const title = node.title.replace(/\s+/g, " ").trim();
      if (pageNumber !== null && title) sections.push({ title, depth, pageNumber });
      if (node.items?.length) await visit(node.items, depth + 1);
    }
  };
  await visit(outline, 0);
  return sections;
}

// The chain of sections containing `pageNumber`, outermost first: at each
// depth, the last section starting on or before the page — dropping any
// deeper sections a later, shallower one closed.
export function sectionPathAt(sections: Section[], pageNumber: number): Section[] {
  const path: Section[] = [];
  for (const section of sections) {
    if (section.pageNumber > pageNumber) continue;
    // Close everything at this depth or deeper, then open this section.
    while (path.length > 0 && path[path.length - 1].depth >= section.depth) path.pop();
    path.push(section);
  }
  return path;
}

export function formatSectionPath(path: Section[]): string {
  return path.map((section) => section.title).join(" › ");
}

// The pages [first, last] a section spans: from its start up to the page
// before the next section at the same or a shallower depth begins (or the
// end of the document). Never ends before it starts — the next section can
// begin on the same page.
export function sectionPageRange(sections: Section[], index: number, numPages: number): [number, number] {
  const section = sections[index];
  const next = sections.slice(index + 1).find((other) => other.depth <= section.depth);
  const last = next ? Math.max(section.pageNumber, next.pageNumber - 1) : numPages;
  return [section.pageNumber, last];
}
