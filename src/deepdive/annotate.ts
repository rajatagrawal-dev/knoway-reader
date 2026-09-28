import type { Element, ElementContent, Root, Text } from "hast";

// Places dive highlights and dive markers onto one turn's rendered markdown,
// as a rehype pass over the finished tree (after KaTeX has rendered math).
//
// A highlight is stored only as the text the reader selected — serialized by
// selectionText.ts with each equation replaced by its "$tex$" source — plus
// where it was made: the turn it's in and which occurrence of that text
// within the turn it was. Finding it again means lining that string back up
// with the rendered tree, which is split into many pieces: text nodes broken
// up by bold/italic/links, and every equation. Doing that in one pass over
// the whole turn, rather than piece by piece as the tree renders, is what
// makes a selection running through several equations reliable:
//
//  - The turn is flattened into "atoms": each text node, and each equation
//    as a single indivisible atom read as "$tex$" (the same form the
//    selection was stored in).
//  - All whitespace is dropped on both sides before searching. Selection
//    capture reads text with innerText, whose line breaks between blocks
//    and spacing around equations never exactly match the tree's own text
//    nodes, but the non-whitespace characters always do.
//  - The stored occurrence picks which match, so a phrase that appears
//    twice in a turn highlights the copy the reader actually selected.
//
// Matched ranges are then cut out of their text nodes and wrapped in a
// <mark data-dive-kind data-dive-id> element (an equation is wrapped whole),
// which DivePanelPane's `mark` component turns into the interactive
// highlight or marker.

export interface AnnotationTarget {
  kind: "highlight" | "marker";
  id: string;
  text: string;
  // Unset for highlights saved before placement was recorded (and for dive
  // markers): those match the first turn they're found in instead.
  turnIndex?: number;
  occurrence?: number;
}

export interface AnnotateOptions {
  turnIndex: number;
  targets: AnnotationTarget[];
  // Shared by every turn in one render of the pane, in turn order: which
  // turn each placement-less target was found in first, so it's placed once
  // rather than on every turn that happens to contain the same text.
  claims: Map<string, number>;
}

type Parent = Root | Element;

type Atom =
  | { kind: "text"; node: Text; parent: Parent; start: number }
  | { kind: "katex"; node: Element; parent: Parent; start: number; tex: string | null; glyphs: string };

function classesOf(node: Element): string[] {
  const className = node.properties.className;
  return Array.isArray(className) ? className.map(String) : [];
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

function findElement(node: Element, test: (element: Element) => boolean): Element | null {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (test(child)) return child;
    const found = findElement(child, test);
    if (found) return found;
  }
  return null;
}

function collectAtoms(root: Root): Atom[] {
  const atoms: Atom[] = [];
  let units = 0;
  const walk = (parent: Parent) => {
    for (const child of parent.children) {
      if (child.type === "text") {
        atoms.push({ kind: "text", node: child, parent, start: units });
        units += child.value.length;
      } else if (child.type === "element") {
        if (classesOf(child).includes("katex")) {
          const annotation = findElement(child, (e) => e.tagName === "annotation");
          const html = findElement(child, (e) => classesOf(e).includes("katex-html"));
          atoms.push({
            kind: "katex",
            node: child,
            parent,
            start: units,
            tex: annotation ? textOf(annotation).trim() : null,
            glyphs: html ? textOf(html) : "",
          });
          units += 1;
        } else {
          walk(child);
        }
      }
    }
  };
  walk(root);
  return atoms;
}

const WHITESPACE = /\s/;

export function compactText(text: string): string {
  return text.replace(/\s+/g, "");
}

// The turn's text with whitespace removed, plus, for each of its characters,
// the "unit" it came from: a character offset for text, or the equation's
// single slot for an equation.
function buildHaystack(atoms: Atom[], mathAs: "tex" | "glyphs"): { text: string; units: number[] } {
  let text = "";
  const units: number[] = [];
  for (const atom of atoms) {
    if (atom.kind === "text") {
      for (let i = 0; i < atom.node.value.length; i++) {
        const ch = atom.node.value[i];
        if (WHITESPACE.test(ch)) continue;
        text += ch;
        units.push(atom.start + i);
      }
    } else {
      const source = mathAs === "tex" && atom.tex !== null ? `$${atom.tex}$` : atom.glyphs;
      const compact = compactText(source);
      text += compact;
      for (let i = 0; i < compact.length; i++) units.push(atom.start);
    }
  }
  return { text, units };
}

function nthIndexOf(haystack: string, needle: string, n: number): number {
  let index = haystack.indexOf(needle);
  for (let i = 0; i < n && index !== -1; i++) {
    index = haystack.indexOf(needle, index + 1);
  }
  // A stored occurrence past the end (turns are append-only, so this
  // shouldn't happen) is better placed on the first copy than dropped.
  return index === -1 ? haystack.indexOf(needle) : index;
}

// Which copy of `needle` in `haystack` (both already compacted) starts
// nearest `position` — the occurrence number selection capture stores, and
// nearest rather than "starts exactly at" so a character's difference in
// how the text before the selection serialized can't shift it onto the
// neighbouring copy. Counted the same (overlapping) way as nthIndexOf.
export function nearestOccurrence(haystack: string, needle: string, position: number): number {
  let best = 0;
  let bestDistance = Infinity;
  let n = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1), n++) {
    const distance = Math.abs(index - position);
    if (distance < bestDistance) {
      best = n;
      bestDistance = distance;
    }
  }
  return best;
}

interface Span {
  start: number;
  end: number;
  target: AnnotationTarget;
}

function locate(target: AnnotationTarget, haystacks: ReturnType<typeof buildHaystack>[]): Span | null {
  const needle = compactText(target.text);
  if (!needle) return null;
  for (const haystack of haystacks) {
    const index = nthIndexOf(haystack.text, needle, target.occurrence ?? 0);
    if (index === -1) continue;
    return {
      start: haystack.units[index],
      end: haystack.units[index + needle.length - 1] + 1,
      target,
    };
  }
  return null;
}

// Highlights win over markers: a marker (text a nested dive was started
// from) is often a whole sentence, and a highlight placed later on a phrase
// inside it must stay clickable. Markers are clipped to the gaps around
// highlights. Among highlights, or among markers, the earliest wins an
// overlap.
function resolveOverlaps(spans: Span[]): Span[] {
  const byStart = (a: Span, b: Span) => a.start - b.start;
  const highlights: Span[] = [];
  let cursor = -1;
  for (const span of spans.filter((s) => s.target.kind === "highlight").sort(byStart)) {
    if (span.start < cursor) continue;
    highlights.push(span);
    cursor = span.end;
  }

  const clipped: Span[] = [];
  for (const marker of spans.filter((s) => s.target.kind === "marker")) {
    let pieces = [{ start: marker.start, end: marker.end }];
    for (const highlight of highlights) {
      pieces = pieces.flatMap((piece) => {
        if (highlight.end <= piece.start || highlight.start >= piece.end) return [piece];
        return [
          { start: piece.start, end: highlight.start },
          { start: highlight.end, end: piece.end },
        ].filter((p) => p.end > p.start);
      });
    }
    for (const piece of pieces) clipped.push({ ...piece, target: marker.target });
  }
  const markers: Span[] = [];
  cursor = -1;
  for (const span of clipped.sort(byStart)) {
    if (span.start < cursor) continue;
    markers.push(span);
    cursor = span.end;
  }
  return [...highlights, ...markers].sort(byStart);
}

function markElement(target: AnnotationTarget, children: ElementContent[]): Element {
  return {
    type: "element",
    tagName: "mark",
    properties: { dataDiveKind: target.kind, dataDiveId: target.id },
    children,
  };
}

function applySpans(atoms: Atom[], spans: Span[]) {
  const replacements = new Map<Parent, Map<ElementContent, ElementContent[]>>();
  const replace = (parent: Parent, node: ElementContent, withNodes: ElementContent[]) => {
    let forParent = replacements.get(parent);
    if (!forParent) replacements.set(parent, (forParent = new Map()));
    forParent.set(node, withNodes);
  };

  for (const atom of atoms) {
    if (atom.kind === "katex") {
      const span = spans.find((s) => s.start <= atom.start && s.end > atom.start);
      if (span) replace(atom.parent, atom.node, [markElement(span.target, [atom.node])]);
      continue;
    }
    const value = atom.node.value;
    const atomEnd = atom.start + value.length;
    const overlapping = spans.filter((s) => s.start < atomEnd && s.end > atom.start);
    // Whitespace-only text between blocks (e.g. the "\n" between two
    // paragraphs) would only become an empty-looking mark between them.
    if (overlapping.length === 0 || value.trim() === "") continue;
    const pieces: ElementContent[] = [];
    let pos = 0;
    for (const span of overlapping) {
      const from = Math.max(span.start - atom.start, pos);
      const to = Math.min(span.end - atom.start, value.length);
      if (from > pos) pieces.push({ type: "text", value: value.slice(pos, from) });
      if (to > from) pieces.push(markElement(span.target, [{ type: "text", value: value.slice(from, to) }]));
      pos = Math.max(pos, to);
    }
    if (pos < value.length) pieces.push({ type: "text", value: value.slice(pos) });
    replace(atom.parent, atom.node, pieces);
  }

  for (const [parent, forParent] of replacements) {
    parent.children = parent.children.flatMap((child) => forParent.get(child as ElementContent) ?? [child]) as typeof parent.children;
  }
}

export function rehypeAnnotate(options: AnnotateOptions) {
  return (tree: Root) => {
    const { turnIndex, targets, claims } = options;
    const candidates = targets.filter((target) => {
      if (target.turnIndex !== undefined) return target.turnIndex === turnIndex;
      const claimedBy = claims.get(`${target.kind}:${target.id}`);
      return claimedBy === undefined || claimedBy === turnIndex;
    });
    if (candidates.length === 0) return;

    const atoms = collectAtoms(tree);
    // Math as TeX first — that's how selections are stored — falling back
    // to the visible glyphs for anything saved before they were.
    const haystacks = [buildHaystack(atoms, "tex"), buildHaystack(atoms, "glyphs")];
    const spans: Span[] = [];
    for (const target of candidates) {
      const span = locate(target, haystacks);
      if (!span) continue;
      spans.push(span);
      if (target.turnIndex === undefined) claims.set(`${target.kind}:${target.id}`, turnIndex);
    }
    applySpans(atoms, resolveOverlaps(spans));
  };
}
