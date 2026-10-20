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
