// Figures on a page — pictures, plots, diagrams, circuits — found from what
// the page draws rather than from its text: every image and filled or
// stroked path is placed on the page, nearby marks are grouped, and each
// group big and busy enough to be a figure becomes one, along with the text
// drawn in it (axis labels, legends) and its "Figure 3: …" caption. Pure:
// the operator list comes from pdf.js (figureIndex.ts), the text runs from
// the library's extractPageTextItems, and `ops` is pdf.js's OPS table.
//
// Units are those of the page at scale 1 (PDF points, top-left origin) —
// the same as the text runs' rects — until the regions are returned as
// fractions of the page.

export interface FigureRegion {
  left: number; // fractions of the page's width/height
  top: number;
  width: number;
  height: number;
  kind: "image" | "drawing";
}

export interface OperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

export interface TextRun {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
}

// pdf.js's getTextContent items, placed on the page — turned with their
// text, so a rotated axis label covers the strip it's drawn in.
export interface TextItemLike {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface PageGeometry {
  width: number;
  height: number;
  // pdf.js's viewport transform at scale 1: PDF user space → page units.
  transform: number[];
}

type Matrix = [number, number, number, number, number, number];

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Mark {
  rect: Rect;
  image: boolean;
}

const GAP = 4; // marks closer than this belong to the same group
const PART_GAP = 12; // groups closer than this are parts of one figure
const SIDE_GAP = 60; // how far a figure's caption reaches for parts beside it
const CELL = 2; // occupancy grid resolution
const HAIRLINE = 1.5; // a mark thinner than this is a rule, not a shape
const MIN_WIDTH = 40;
const MIN_HEIGHT = 30;
const MIN_MARKS = 6; // a drawing with fewer marks is a frame or a rule, unless it has a caption
const MIN_CAPTIONED_MARKS = 2;
const MAX_MARK_AREA = 0.6; // a mark covering more of the page is a background
const MAX_FIGURE_AREA = 0.85; // a "figure" filling the page is a scanned page
// "Figure 3:", "Fig. 2.", "Table 1 |" — a label then punctuation, which a
// sentence that merely starts with "Fig. 2 shows…" doesn't have.
const CAPTION = /^\s*(?:fig(?:ure)?s?\.?|table|tab\.)\s*[A-Z]?\d+(?:\.\d+)*[a-z]?(?=\s*[.:|—–-]|\s*$)/i;
const MAX_CAPTION_LINES = 14;
const MARGIN_BAND = 0.1; // top and bottom of the page, where running heads and feet go

// ---- Geometry ---------------------------------------------------------------------

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const emptyRect = (): Rect => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
const isEmpty = (r: Rect) => !(r.right >= r.left && r.bottom >= r.top);
const width = (r: Rect) => r.right - r.left;
const height = (r: Rect) => r.bottom - r.top;
const area = (r: Rect) => (isEmpty(r) ? 0 : width(r) * height(r));

function addPoint(r: Rect, m: Matrix, x: number, y: number) {
  const px = m[0] * x + m[2] * y + m[4];
  const py = m[1] * x + m[3] * y + m[5];
  r.left = Math.min(r.left, px);
  r.right = Math.max(r.right, px);
  r.top = Math.min(r.top, py);
  r.bottom = Math.max(r.bottom, py);
}

function transformBox(m: Matrix, x0: number, y0: number, x1: number, y1: number): Rect {
  const r = emptyRect();
  addPoint(r, m, x0, y0);
  addPoint(r, m, x1, y0);
  addPoint(r, m, x0, y1);
  addPoint(r, m, x1, y1);
  return r;
}

function intersect(a: Rect, b: Rect | null): Rect {
  if (!b) return a;
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

function union(a: Rect, b: Rect): Rect {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function near(a: Rect, b: Rect, gap: number): boolean {
  return a.left - gap <= b.right && b.left - gap <= a.right && a.top - gap <= b.bottom && b.top - gap <= a.bottom;
}

function overlapArea(a: Rect, b: Rect): number {
  return area(intersect(a, b));
}

// ---- Marks: what the page draws, and where ------------------------------------------

// The bounds of a constructPath's segments (control points included, so a
// curve's box may be a little generous).
function pathBounds(ops: Record<string, number>, segments: ArrayLike<number>, coords: ArrayLike<number>, m: Matrix): Rect {
  const r = emptyRect();
  let j = 0;
  for (let i = 0; i < segments.length; i += 1) {
    switch (segments[i]) {
      case ops.rectangle: {
        const [x, y, w, h] = [coords[j], coords[j + 1], coords[j + 2], coords[j + 3]];
        j += 4;
        const box = transformBox(m, x, y, x + w, y + h);
        Object.assign(r, union(r, box));
        break;
      }
      case ops.moveTo:
      case ops.lineTo:
        addPoint(r, m, coords[j], coords[j + 1]);
        j += 2;
        break;
      case ops.curveTo:
        for (let k = 0; k < 6; k += 2) addPoint(r, m, coords[j + k], coords[j + k + 1]);
        j += 6;
        break;
      case ops.curveTo2:
      case ops.curveTo3:
        for (let k = 0; k < 4; k += 2) addPoint(r, m, coords[j + k], coords[j + k + 1]);
        j += 4;
        break;
      default:
        break; // closePath: no coordinates
    }
  }
  return r;
}

export function collectMarks(
  list: OperatorListLike,
  ops: Record<string, number>,
  page: PageGeometry,
): Mark[] {
  const marks: Mark[] = [];
  const pageArea = page.width * page.height;
  // Paint in white is taken as invisible: a plot's own background, or a
  // mask over what's behind it, rather than part of the figure.
  interface State {
    m: Matrix;
    clip: Rect | null;
    whiteFill: boolean;
    whiteStroke: boolean;
  }
  const stack: State[] = [];
  let state: State = {
    m: page.transform.slice(0, 6) as Matrix,
    clip: { left: 0, top: 0, right: page.width, bottom: page.height },
    whiteFill: false,
    whiteStroke: false,
  };
  let path: Rect | null = null;
  let clipping = false;
  let inAnnotation = 0;

  const fills = new Set([ops.fill, ops.eoFill]);
  const strokes = new Set([ops.stroke, ops.closeStroke]);
  const both = new Set([ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]);
  const isWhite = (args: unknown[] | null) =>
    Array.isArray(args) && args.length >= 3 && args.slice(0, 3).every((v) => typeof v === "number" && v >= 250);
  const images = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageXObjectRepeat]);
  const masks = new Set([
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectGroup,
    ops.paintImageMaskXObjectRepeat,
    ops.paintInlineImageXObjectGroup,
    ops.paintSolidColorImageMask,
  ]);

  const add = (rect: Rect, image: boolean) => {
    const visible = intersect(rect, state.clip);
    if (isEmpty(visible) || area(visible) > pageArea * MAX_MARK_AREA) return;
    // Hairlines have no area of their own; give them a sliver so they count.
    if (width(visible) < 0.5) visible.right = visible.left + 0.5;
    if (height(visible) < 0.5) visible.bottom = visible.top + 0.5;
    marks.push({ rect: visible, image });
  };

  for (let i = 0; i < list.fnArray.length; i += 1) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[] | null;
    if (fn === ops.beginAnnotation) inAnnotation += 1;
    else if (fn === ops.endAnnotation) inAnnotation = Math.max(0, inAnnotation - 1);
    if (inAnnotation) continue;

    if (fn === ops.save) {
      stack.push(state);
      state = { ...state };
    } else if (fn === ops.restore) {
      state = stack.pop() ?? state;
    } else if (fn === ops.transform && args) {
      state.m = multiply(state.m, args as Matrix);
    } else if (fn === ops.setFillRGBColor) {
      state.whiteFill = isWhite(args);
    } else if (fn === ops.setStrokeRGBColor) {
      state.whiteStroke = isWhite(args);
    } else if (fn === ops.setFillColorN) {
      state.whiteFill = false; // a pattern
    } else if (fn === ops.setStrokeColorN) {
      state.whiteStroke = false;
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(state);
      state = { ...state };
      const [matrix, bbox] = (args ?? []) as [Matrix | null, number[] | null];
      if (matrix) state.m = multiply(state.m, matrix);
      if (bbox) state.clip = intersect(transformBox(state.m, bbox[0], bbox[1], bbox[2], bbox[3]), state.clip);
    } else if (fn === ops.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (fn === ops.constructPath && args) {
      const [segments, coords] = args as [ArrayLike<number>, ArrayLike<number>];
      const bounds = pathBounds(ops, segments, coords, state.m);
      path = path ? union(path, bounds) : bounds;
    } else if (fn === ops.clip || fn === ops.eoClip) {
      clipping = true;
    } else if (fills.has(fn) || strokes.has(fn) || both.has(fn) || fn === ops.endPath) {
      if (path && !isEmpty(path)) {
        const visible =
          (fills.has(fn) && !state.whiteFill) ||
          (strokes.has(fn) && !state.whiteStroke) ||
          (both.has(fn) && !(state.whiteFill && state.whiteStroke));
        if (visible) add(path, false);
        if (clipping) state.clip = intersect(path, state.clip);
      }
      path = null;
      clipping = false;
    } else if (images.has(fn)) {
      add(transformBox(state.m, 0, 0, 1, 1), true);
    } else if (masks.has(fn)) {
      if (!state.whiteFill) add(transformBox(state.m, 0, 0, 1, 1), false);
    } else if (fn === ops.shadingFill) {
      if (state.clip) add({ ...state.clip }, false);
    }
  }
  return marks;
}

// ---- Grouping ---------------------------------------------------------------------------

interface Group {
  rect: Rect;
  marks: number;
  shapes: number; // marks that aren't hairlines
  imageArea: number;
}

// Connected groups of marks within GAP of each other, found on a coarse
// occupancy grid so a page with thousands of plot markers stays fast.
export function groupMarks(marks: Mark[], page: { width: number; height: number }): Group[] {
  const cols = Math.ceil(page.width / CELL) + 1;
  const rows = Math.ceil(page.height / CELL) + 1;
  const grid = new Int32Array(cols * rows); // 0 empty, -1 occupied, >0 group id
  const cellOf = (v: number, max: number) => Math.min(max - 1, Math.max(0, Math.floor(v / CELL)));
  const pad = GAP / 2;
  for (const mark of marks) {
    const c0 = cellOf(mark.rect.left - pad, cols);
    const c1 = cellOf(mark.rect.right + pad, cols);
    const r0 = cellOf(mark.rect.top - pad, rows);
    const r1 = cellOf(mark.rect.bottom + pad, rows);
    for (let r = r0; r <= r1; r += 1) grid.fill(-1, r * cols + c0, r * cols + c1 + 1);
  }

  let groups = 0;
  const queue: number[] = [];
  for (let start = 0; start < grid.length; start += 1) {
    if (grid[start] !== -1) continue;
    groups += 1;
    grid[start] = groups;
    queue.push(start);
    while (queue.length) {
      const cell = queue.pop()!;
      const c = cell % cols;
      const neighbours = [cell - cols, cell + cols, c > 0 ? cell - 1 : -1, c < cols - 1 ? cell + 1 : -1];
      for (const n of neighbours) {
        if (n >= 0 && n < grid.length && grid[n] === -1) {
          grid[n] = groups;
          queue.push(n);
        }
      }
    }
  }

  const found = new Map<number, Group>();
  for (const mark of marks) {
    const cx = cellOf((mark.rect.left + mark.rect.right) / 2, cols);
    const cy = cellOf((mark.rect.top + mark.rect.bottom) / 2, rows);
    const id = grid[cy * cols + cx];
    const group = found.get(id) ?? { rect: { ...mark.rect }, marks: 0, shapes: 0, imageArea: 0 };
    group.rect = union(group.rect, mark.rect);
    group.marks += 1;
    if (Math.min(width(mark.rect), height(mark.rect)) >= HAIRLINE) group.shapes += 1;
    if (mark.image) group.imageArea += area(mark.rect);
    found.set(id, group);
  }
  return [...found.values()];
}

function absorb(into: Group, other: Group) {
  into.rect = union(into.rect, other.rect);
  into.marks += other.marks;
  into.shapes += other.shapes;
  into.imageArea += other.imageArea;
}

// ---- Text: labels inside a figure, and its caption ----------------------------------------

export function placeTextItems(items: TextItemLike[], page: PageGeometry): TextRun[] {
  const v = page.transform.slice(0, 6) as Matrix;
  return items.flatMap((item) => {
    if (!item.str || !item.transform) return [];
    const [a, b, c, d, x, y] = item.transform;
    const along = Math.hypot(a, b) || 1;
    const up = Math.hypot(c, d) || 1;
    const w = Math.abs(item.width);
    const h = Math.abs(item.height);
    const r = emptyRect();
    addPoint(r, v, x, y);
    addPoint(r, v, x + (a / along) * w, y + (b / along) * w);
    addPoint(r, v, x + (c / up) * h, y + (d / up) * h);
    addPoint(r, v, x + (a / along) * w + (c / up) * h, y + (b / along) * w + (d / up) * h);
    return [{ text: item.str, rect: { left: r.left, top: r.top, width: width(r), height: height(r) } }];
  });
}

interface Line {
  text: string;
  rect: Rect;
  lineHeight: number;
}

// Runs joined into lines: the same baseline, and close enough not to be the
// same line of the other column.
function textLines(runs: TextRun[]): Line[] {
  const items = runs
    .filter((run) => run.text.trim() && run.rect.width > 0 && run.rect.height > 0)
    .map((run) => ({
      text: run.text,
      rect: {
        left: run.rect.left,
        top: run.rect.top,
        right: run.rect.left + run.rect.width,
        bottom: run.rect.top + run.rect.height,
      },
    }))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const lines: Line[] = [];
  for (const item of items) {
    const h = height(item.rect);
    const line = lines.find(
      (l) =>
        Math.abs(l.rect.top - item.rect.top) < Math.min(h, l.lineHeight) * 0.5 &&
        item.rect.left - l.rect.right < h * 0.8 &&
        l.rect.left - item.rect.right < h * 0.8,
    );
    if (line) {
      const before = item.rect.left < line.rect.left;
      line.text = before ? `${item.text} ${line.text}` : `${line.text} ${item.text}`;
      line.rect = union(line.rect, item.rect);
      line.lineHeight = Math.max(line.lineHeight, h);
    } else {
      lines.push({ text: item.text, rect: { ...item.rect }, lineHeight: h });
    }
  }
  return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

// Text drawn in the figure (partly inside it, and no wider than it), or
// short lines just beside it — tick labels and axis titles that sit outside
// the axes' own lines. Long lines next to it are the body text it's set in,
// and stay out.
function absorbLabels(rect: Rect, lines: Line[]): Rect {
  let grown = rect;
  for (let round = 0; round < 2; round += 1) {
    const before = grown;
    for (const line of lines) {
      const overlap = overlapArea(line.rect, grown);
      const inside = overlap >= area(line.rect) * 0.6 || (overlap > 0 && width(line.rect) <= width(before) * 0.85);
      const short = width(line.rect) <= Math.min(150, Math.max(80, width(before) * 0.6));
      const besideH = line.rect.bottom > before.top && line.rect.top < before.bottom && near(line.rect, before, 25);
      const besideV = near(line.rect, before, line.lineHeight * 0.8);
      if (inside || (short && (besideH || besideV))) grown = union(grown, line.rect);
    }
    if (grown === before) break;
  }
  return grown;
}

// Whether any text sits in the space between two boxes — body text keeps
// two figures (or a figure and an unrelated mark) apart.
function textBetween(a: Rect, b: Rect, lines: Line[]): boolean {
  const between = union(a, b);
  return lines.some(
    (line) =>
      overlapArea(line.rect, between) > area(line.rect) * 0.5 &&
      !overlapArea(line.rect, a) &&
      !overlapArea(line.rect, b),
  );
}

// A caption's whole paragraph, from its "Figure 3:" line on.
function captionBlock(lines: Line[], index: number, stopAt = Infinity): Rect {
  const first = lines[index];
  let caption = { ...first.rect };
  let count = 1;
  for (let k = index + 1; k < lines.length && count < MAX_CAPTION_LINES; k += 1) {
    const next = lines[k];
    if (next.rect.right < caption.left || next.rect.left > caption.right) continue; // another column
    if (next.rect.top - caption.bottom > first.lineHeight * 0.8 || next.rect.top >= stopAt) break;
    caption = union(caption, next.rect);
    count += 1;
  }
  return caption;
}

// The nearest "Figure 3: …" / "Table 2." line just below (or above) the
// figure, overlapping it horizontally, and the rest of its paragraph.
function findCaption(rect: Rect, lines: Line[]): Rect | null {
  let best: { index: number; distance: number; above: boolean } | null = null;
  lines.forEach((line, index) => {
    if (!isCaption(lines, index)) return;
    if (line.rect.right < rect.left || line.rect.left > rect.right) return;
    const slack = line.lineHeight * 0.5;
    const reach = line.lineHeight * 4;
    const below = line.rect.top - rect.bottom;
    const above = rect.top - line.rect.bottom;
    // Below is the usual place, so it wins a tie.
    if (below >= -slack && below <= reach && (!best || below < best.distance)) {
      best = { index, distance: below, above: false };
    } else if (above >= -slack && above <= reach && (!best || above + slack < best.distance)) {
      best = { index, distance: above, above: true };
    }
  });
  if (!best) return null;
  const { index, above } = best as { index: number; above: boolean };
  return captionBlock(lines, index, above ? rect.top : Infinity);
}

const overlapsH = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right;

// Whether line `index` reads as a caption: a "Figure 3:" label starting a
// paragraph, not a sentence that wrapped onto a new line at "Figure 3."
function isCaption(lines: Line[], index: number): boolean {
  const line = lines[index];
  if (!CAPTION.test(line.text)) return false;
  return !lines.some(
    (other, k) =>
      k !== index &&
      other.rect.bottom <= line.rect.top + line.lineHeight * 0.3 &&
      line.rect.top - other.rect.bottom <= line.lineHeight * 0.8 &&
      overlapsH(other.rect, line.rect) &&
      width(other.rect) >= width(line.rect) * 0.6,
  );
}

// Body text set in a box — a framed theorem or summary, drawn with a
// border — is not a figure: several lines inside that span most of it.
function textHeavy(rect: Rect, lines: Line[]): boolean {
  let count = 0;
  for (const line of lines) {
    if (overlapArea(line.rect, rect) >= area(line.rect) * 0.6 && width(line.rect) >= width(rect) * 0.5) count += 1;
  }
  return count >= 4;
}

// ---- Figures -------------------------------------------------------------------------------

type Part = Group & { rules: boolean };

export function findFigures(
  list: OperatorListLike,
  ops: Record<string, number>,
  page: PageGeometry,
  runs: TextRun[],
): FigureRegion[] {
  const pageArea = page.width * page.height;
  const lines = textLines(runs);

  // Rules alone (fraction bars, table and header rules) are never a figure
  // by themselves; they only join one, or make up a captioned table.
  // A wide rule in the top or bottom margin is a running head's or foot's.
  const margin = (rect: Rect) =>
    width(rect) >= page.width * 0.4 && (rect.bottom <= page.height * MARGIN_BAND || rect.top >= page.height * (1 - MARGIN_BAND));
  const parts: Part[] = groupMarks(collectMarks(list, ops, page), page).flatMap((group) => {
    const rules = group.shapes === 0 && group.imageArea === 0;
    if (rules && margin(group.rect)) return [];
    return [{ ...group, rules, rect: rules ? group.rect : absorbLabels(group.rect, lines) }];
  });

  // Parts close together — a plot and its colour bar, the boxes of a
  // diagram — are one figure, unless there's text between them.
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < parts.length && !merged; i += 1) {
      for (let j = i + 1; j < parts.length && !merged; j += 1) {
        if (parts[i].rules && parts[j].rules) continue;
        if (!near(parts[i].rect, parts[j].rect, PART_GAP) || textBetween(parts[i].rect, parts[j].rect, lines)) continue;
        absorb(parts[i], parts[j]);
        parts[i].rules = false;
        parts.splice(j, 1);
        merged = true;
      }
    }
  }

  const isImage = (group: Group) => group.imageArea >= MIN_WIDTH * MIN_HEIGHT;
  const bigEnough = (rect: Rect) =>
    width(rect) >= MIN_WIDTH && height(rect) >= MIN_HEIGHT && area(rect) <= pageArea * MAX_FIGURE_AREA;

  const figures: { rect: Rect; kind: FigureRegion["kind"] }[] = [];
  const used = new Set<Part>();

  // Smaller pieces set beside a figure (a second diagram, a gate drawn
  // apart from its circuit) belong to it too.
  const takeSideParts = (rect: Rect): Rect => {
    for (const other of parts) {
      if (used.has(other) || other.rules) continue;
      const level = other.rect.top >= rect.top - PART_GAP && other.rect.bottom <= rect.bottom + PART_GAP;
      if (!level || !near(other.rect, rect, SIDE_GAP) || textBetween(other.rect, rect, lines)) continue;
      rect = union(rect, other.rect);
      used.add(other);
    }
    return rect;
  };

  // First from each caption: everything drawn between it and the body text
  // above it (or, for a caption set above, below it) is its figure — which
  // gathers a composite figure's scattered pieces, and a table's rules.
  const captions = lines.flatMap((_, index) => (isCaption(lines, index) ? [captionBlock(lines, index)] : []));

  // Where a caption's figure can be: from the caption up to the body text
  // above it (or down to the text below), across the text column — which
  // a short, centred caption doesn't span.
  const zone = (caption: Rect, direction: "above" | "below"): Rect => {
    const isBody = (line: Line) =>
      !CAPTION.test(line.text) &&
      overlapsH(line.rect, caption) &&
      width(line.rect) >= width(caption) * 0.4 &&
      !parts.some((part) => !part.rules && overlapArea(part.rect, line.rect) > 0);
    const body = lines.filter(isBody).map((line) => line.rect);
    const bounds = [...body, ...captions.filter((other) => other !== caption && overlapsH(other, caption))];
    const above = body.filter((r) => r.bottom <= caption.top).sort((a, b) => b.bottom - a.bottom)[0];
    const below = body.filter((r) => r.top >= caption.bottom).sort((a, b) => a.top - b.top)[0];
    const column = [above, below].filter((r): r is Rect => Boolean(r)).reduce(union, caption);
    if (direction === "above") {
      const top = Math.max(0, ...bounds.filter((r) => r.bottom <= caption.top).map((r) => r.bottom));
      return { left: column.left, right: column.right, top, bottom: caption.top };
    }
    const bottom = Math.min(page.height, ...bounds.filter((r) => r.top >= caption.bottom).map((r) => r.top));
    return { left: column.left, right: column.right, top: caption.bottom, bottom };
  };

  // Every caption looks above itself before any looks below, so a caption
  // under one figure isn't claimed by the figure under it instead.
  const claimed = new Set<Rect>();
  for (const direction of ["above", "below"] as const) {
    for (const caption of captions) {
      if (claimed.has(caption)) continue;
      const within = zone(caption, direction);
      let members = parts.filter(
        (part) =>
          !used.has(part) &&
          overlapsH(part.rect, within) &&
          part.rect.top >= within.top - 2 &&
          part.rect.bottom <= within.bottom + 2,
      );
      // Rules belong with the drawing they're set in (a separator between
      // its halves); only a table is rules alone.
      const drawn = members.filter((part) => !part.rules);
      if (drawn.length) {
        const extent = drawn.map((part) => part.rect).reduce(union);
        members = members.filter(
          (part) => !part.rules || (part.rect.top >= extent.top - PART_GAP && part.rect.bottom <= extent.bottom + PART_GAP),
        );
      }
      if (!members.length) continue;
      const image = members.some(isImage);
      const marks = members.reduce((sum, part) => sum + part.marks, 0);
      let rect = members.map((part) => part.rect).reduce(union);
      if (!bigEnough(rect) || (!image && marks < MIN_CAPTIONED_MARKS)) continue;
      rect = absorbLabels(rect, lines);
      if (textHeavy(rect, lines)) continue;
      members.forEach((part) => used.add(part));
      claimed.add(caption);
      figures.push({ rect: union(takeSideParts(rect), caption), kind: image ? "image" : "drawing" });
    }
  }

  // Then figures without a caption close by, judged on their own.
  for (const part of parts) {
    if (used.has(part) || part.rules || !bigEnough(part.rect) || textHeavy(part.rect, lines)) continue;
    const caption = findCaption(part.rect, lines);
    if (!isImage(part) && part.marks < (caption ? MIN_CAPTIONED_MARKS : MIN_MARKS)) continue;
    used.add(part);
    let rect = part.rect;
    if (caption) rect = union(takeSideParts(rect), caption);
    figures.push({ rect, kind: isImage(part) ? "image" : "drawing" });
  }

  // Subfigures that share a caption end up overlapping: one figure.
  const result: typeof figures = [];
  for (const figure of figures) {
    const into = result.find((other) => overlapArea(other.rect, figure.rect) > 0);
    if (into) {
      into.rect = union(into.rect, figure.rect);
      if (figure.kind === "image") into.kind = "image";
    } else {
      result.push({ ...figure });
    }
  }

  const pad = 3;
  return result.map(({ rect, kind }) => {
    const left = Math.max(0, rect.left - pad);
    const top = Math.max(0, rect.top - pad);
    const right = Math.min(page.width, rect.right + pad);
    const bottom = Math.min(page.height, rect.bottom + pad);
    return {
      left: left / page.width,
      top: top / page.height,
      width: (right - left) / page.width,
      height: (bottom - top) / page.height,
      kind,
    };
  });
}
