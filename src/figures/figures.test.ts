import test from "node:test";
import assert from "node:assert/strict";
import { findFigures, placeTextItems, type FigureRegion, type TextRun } from "./detect.ts";

// A 600×800 page. Drawing is given in page units (top-left origin) and
// turned into the bottom-up PDF operators pdf.js would hand over.
const PAGE = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };

const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  shadingFill: 62,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageMaskXObject: 83,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  constructPath: 91,
};

class Drawing {
  fnArray: number[] = [];
  argsArray: unknown[] = [];
  op(fn: number, args: unknown = null) {
    this.fnArray.push(fn);
    this.argsArray.push(args);
    return this;
  }
  // A rectangle at (left, top) in page units, filled or stroked.
  rect(left: number, top: number, width: number, height: number, paint = OPS.fill) {
    const y = PAGE.height - top - height;
    return this.op(OPS.constructPath, [[OPS.rectangle], [left, y, width, height], [left, y, left + width, y + height]]).op(paint);
  }
  line(x0: number, y0: number, x1: number, y1: number) {
    const [a, b] = [PAGE.height - y0, PAGE.height - y1];
    return this.op(OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [x0, a, x1, b], []]).op(OPS.stroke);
  }
  image(left: number, top: number, width: number, height: number) {
    return this.op(OPS.save)
      .op(OPS.transform, [width, 0, 0, height, left, PAGE.height - top - height])
      .op(OPS.paintImageXObject, ["img1", width, height])
      .op(OPS.restore);
  }
  white() {
    return this.op(OPS.setFillRGBColor, [255, 255, 255]);
  }
  black() {
    return this.op(OPS.setFillRGBColor, [0, 0, 0]);
  }
}

// A line of text at (left, top), 5 units per character, 10 tall.
const run = (text: string, left: number, top: number): TextRun => ({
  text,
  rect: { left, top, width: text.length * 5, height: 10 },
});

// Body text: full-width lines from `top` down.
const paragraph = (top: number, lines: number, left = 60): TextRun[] =>
  Array.from({ length: lines }, (_, i) => run("x".repeat(96), left, top + i * 12));

// In page units again, rounded, for comparing.
const units = (figure: FigureRegion) => ({
  left: Math.round(figure.left * PAGE.width),
  top: Math.round(figure.top * PAGE.height),
  right: Math.round((figure.left + figure.width) * PAGE.width),
  bottom: Math.round((figure.top + figure.height) * PAGE.height),
  kind: figure.kind,
});

test("an image with its caption below is one figure", () => {
  const drawing = new Drawing().image(150, 200, 300, 200);
  const text = [...paragraph(100, 6), run("Figure 2: A plot of the loss.", 150, 410), ...paragraph(450, 4)];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "image");
  assert.ok(figures[0].top <= 200 && figures[0].top >= 190);
  assert.ok(figures[0].bottom >= 420 && figures[0].bottom < 450, "takes the caption, not the text after it");
});

test("a diagram of strokes and its labels is a figure; body text beside it is not", () => {
  const drawing = new Drawing();
  for (let i = 0; i < 4; i += 1) drawing.rect(200 + i * 50, 300, 30, 30, OPS.stroke).line(230 + i * 50, 315, 250 + i * 50, 315);
  const text = [...paragraph(250, 3), run("H", 210, 310), run("x", 180, 312), ...paragraph(360, 3)];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "drawing");
  assert.ok(figures[0].left <= 180, "takes the label beside it");
  assert.ok(figures[0].top >= 285 && figures[0].bottom <= 350, "but not the paragraphs above and below");
});

test("rules alone — fraction bars, a running head's rule — are not figures", () => {
  const drawing = new Drawing();
  for (let i = 0; i < 8; i += 1) drawing.rect(100 + i * 20, 400, 15, 0.4);
  drawing.rect(60, 50, 480, 0.5);
  assert.deepEqual(findFigures(drawing, OPS, PAGE, paragraph(100, 20)), []);
});

test("a framed box of body text is not a figure", () => {
  const drawing = new Drawing().rect(55, 200, 490, 120, OPS.stroke);
  for (let i = 0; i < 6; i += 1) drawing.rect(100 + i * 60, 250, 20, 0.5);
  const text = [run("Box 2.2: The spectral decomposition", 200, 205), ...paragraph(220, 8)];
  assert.deepEqual(findFigures(drawing, OPS, PAGE, text), []);
});

test("a sentence that wraps at 'Figure 1.3.' is not the caption", () => {
  const drawing = new Drawing();
  for (let i = 0; i < 6; i += 1) drawing.rect(250 + i * 15, 300, 10, 40, OPS.stroke);
  const text = [
    run("x".repeat(96), 60, 250),
    run("Figure 1.3. This sphere is often called the Bloch sphere; it provides a means of", 60, 262),
    run("Figure 1.3. Bloch sphere representation of a qubit.", 180, 360),
  ];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.ok(figures[0].top >= 290, "doesn't reach up into the paragraph");
  assert.ok(figures[0].bottom >= 370, "takes the real caption below");
});

test("a composite figure's scattered pieces are gathered by its caption", () => {
  const drawing = new Drawing();
  const pieces = [
    [80, 120],
    [260, 120],
    [80, 220],
    [420, 160],
  ];
  for (const [left, top] of pieces) drawing.rect(left, top, 40, 25, OPS.stroke).line(left - 10, top + 12, left, top + 12);
  const text = [run("Figure 1.6. Some gates, and a circuit.", 80, 300), ...paragraph(330, 5)];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.ok(figures[0].left <= 70 && figures[0].right >= 460);
  assert.ok(figures[0].top <= 120 && figures[0].bottom >= 310);
});

test("white paint (a plot's background) doesn't stretch the figure", () => {
  const drawing = new Drawing().white().rect(20, 100, 560, 300).black();
  for (let i = 0; i < 8; i += 1) drawing.line(200 + i * 20, 200, 210 + i * 20, 260);
  const figures = findFigures(drawing, OPS, PAGE, []).map(units);
  assert.equal(figures.length, 1);
  assert.ok(figures[0].left >= 190 && figures[0].right <= 360);
});

test("a figure filling the page (a scanned page) is not offered", () => {
  const drawing = new Drawing().image(0, 0, 600, 800);
  assert.deepEqual(findFigures(drawing, OPS, PAGE, []), []);
});

test("rotated text is placed along its rotation", () => {
  // Rotated 90° anticlockwise at (100, 300) in PDF space: reads upward.
  const [placed] = placeTextItems([{ str: "Loss", transform: [0, 10, -10, 0, 100, 300], width: 20, height: 10 }], PAGE);
  assert.deepEqual(
    { left: placed.rect.left, top: placed.rect.top, width: placed.rect.width, height: placed.rect.height },
    { left: 90, top: 480, width: 10, height: 20 },
  );
});

// ---- Tables and algorithms ------------------------------------------------------------

// A booktabs-style table: top, middle and bottom rules from `left` to
// `right`, a header row and `rows` rows of three cells, starting at `top`.
function table(drawing: Drawing, top: number, rows: number, left = 100, right = 500): TextRun[] {
  const text: TextRun[] = [];
  drawing.rect(left, top, right - left, 0.4);
  text.push(run("Name", left + 5, top + 4), run("Value", left + 150, top + 4), run("Error", left + 300, top + 4));
  drawing.rect(left, top + 17, right - left, 0.4);
  for (let i = 0; i < rows; i += 1) {
    const y = top + 21 + i * 12;
    text.push(run(`row ${i}`, left + 5, y), run(`${i}.25`, left + 150, y), run(`0.0${i}`, left + 300, y));
  }
  drawing.rect(left, top + 21 + rows * 12 + 2, right - left, 0.4);
  return text;
}

test("a table with its caption above is found, caption and all", () => {
  const drawing = new Drawing();
  const text = [
    ...paragraph(100, 5),
    run("Table 1. Results on the test set.", 100, 180),
    ...table(drawing, 196, 5),
    ...paragraph(300, 5),
  ];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "table");
  assert.ok(figures[0].top <= 180 && figures[0].top >= 170, "from the caption");
  assert.ok(figures[0].bottom >= 279 && figures[0].bottom < 300, "to the bottom rule, not the paragraph after");
});

test("a table with its caption below is found", () => {
  const drawing = new Drawing();
  const text = [...paragraph(100, 5), ...table(drawing, 180, 4), run("Table 2: Timings.", 100, 260), ...paragraph(290, 5)];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "table");
  assert.ok(figures[0].top <= 180 && figures[0].bottom >= 270 && figures[0].bottom < 290);
});

test("two tables stacked, captions above, each get their own rows", () => {
  const drawing = new Drawing();
  const text = [
    run("Table 5. The first set.", 100, 100),
    ...table(drawing, 116, 4),
    run("Table 6. The second set.", 100, 200),
    ...table(drawing, 216, 3),
    ...paragraph(320, 4),
  ];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units).sort((a, b) => a.top - b.top);
  assert.equal(figures.length, 2);
  assert.ok(figures[0].top <= 100 && figures[0].bottom < 200, "the first stops before the second caption");
  assert.ok(figures[1].top <= 200 && figures[1].top > 190 && figures[1].bottom >= 275);
});

test("an uncaptioned ruled table is found from its rules", () => {
  const drawing = new Drawing();
  const text = [...paragraph(100, 5), ...table(drawing, 180, 6), ...paragraph(300, 5)];
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "table");
});

test("a grid table is found; a framed box of text is not", () => {
  const grid = new Drawing();
  // Four rows of three cells, vertical rules drawn a row at a time.
  for (let r = 0; r <= 4; r += 1) grid.rect(100, 200 + r * 15, 300, 0.4);
  for (let r = 0; r < 4; r += 1) for (const x of [100, 200, 300, 400]) grid.rect(x, 200 + r * 15, 0.4, 15);
  const cells = [0, 1, 2, 3].flatMap((r) => [run(`a${r}`, 110, 203 + r * 15), run(`b${r}`, 210, 203 + r * 15)]);
  const figures = findFigures(grid, OPS, PAGE, [...paragraph(100, 5), ...cells]).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "table");

  const frame = new Drawing().rect(100, 200, 300, 0.4).rect(100, 300, 300, 0.4).rect(100, 200, 0.4, 100).rect(400, 200, 0.4, 100);
  assert.deepEqual(findFigures(frame, OPS, PAGE, paragraph(205, 7, 105).map((r) => ({ ...r, rect: { ...r.rect, width: 280 } }))), []);
});

test("an algorithm captioned between rules is found, without punctuation after its number", () => {
  const drawing = new Drawing().rect(300, 100, 240, 0.4).rect(300, 114, 240, 0.4);
  const text = [run("Algorithm 1 Game Ridge Rider", 302, 102)];
  for (let i = 0; i < 6; i += 1) text.push(run(`${i + 1}: step ${i}`, 305 + (i % 3) * 10, 118 + i * 12));
  drawing.rect(300, 118 + 6 * 12 + 2, 240, 0.4);
  text.push(run("4. Experiments", 300, 215), ...paragraph(230, 4, 300).map((r) => ({ ...r, rect: { ...r.rect, width: 240 } })));
  const figures = findFigures(drawing, OPS, PAGE, text).map(units);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].kind, "algorithm");
  assert.ok(figures[0].top <= 100 && figures[0].bottom >= 192 && figures[0].bottom < 215);
});

test("letters drawn as bitmaps are text, not a picture", () => {
  const drawing = new Drawing();
  for (let i = 0; i < 10; i += 1) {
    drawing
      .op(OPS.save)
      .op(OPS.transform, [30, 0, 0, 7, 100 + (i % 5) * 40, 800 - 300 - Math.floor(i / 5) * 12])
      .op(OPS.paintImageMaskXObject, [{}])
      .op(OPS.restore);
  }
  assert.deepEqual(findFigures(drawing, OPS, PAGE, paragraph(280, 4)), []);
});
