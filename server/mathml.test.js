import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText, mathToTex } from "./mathml.js";

// As Wiktionary's definition API sends it: MathML with no TeX source.
const BELL_STATE =
  '<math class="mwe-math-element mwe-math-element-inline"><mrow data-mjx-texclass="ORD"><mstyle displaystyle="true" scriptlevel="0"><mo stretchy="false">|</mo><msup><mi mathvariant="normal">Φ</mi><mrow data-mjx-texclass="ORD"><mo stretchy="false">+</mo></mrow></msup><mo stretchy="false">⟩</mo><mo stretchy="false">=</mo><mfrac><mrow><mn>1</mn></mrow><mrow><mrow data-mjx-texclass="ORD"><msqrt><mn>2</mn></msqrt></mrow></mrow></mfrac><mo stretchy="false">(</mo><mo stretchy="false">|</mo><mn>00</mn><mo stretchy="false">⟩</mo><mo stretchy="false">+</mo><mo stretchy="false">|</mo><mn>11</mn><mo stretchy="false">⟩</mo><mo stretchy="false">)</mo></mstyle></mrow></math>';

test("converts bare MathML to LaTeX", () => {
  assert.equal(mathToTex(BELL_STATE), "|\\Phi^{+}\\rangle=\\frac{1}{\\sqrt{2}}(|00\\rangle+|11\\rangle)");
  assert.equal(
    mathToTex("<math><msubsup><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></msubsup><msub><mi>x</mi><mi>i</mi></msub></math>"),
    "\\sum_{i=1}^{n}x_{i}",
  );
  assert.equal(mathToTex("<math><mover><mi>v</mi><mo>→</mo></mover><mo>−</mo><mi>sin</mi><mi>α</mi><mi>b</mi></math>"), "\\vec{v}-\\sin\\alpha b");
  assert.equal(
    mathToTex("<math><mrow><mo>(</mo><mtable><mtr><mtd><mn>1</mn></mtd><mtd><mn>0</mn></mtd></mtr><mtr><mtd><mn>0</mn></mtd><mtd><mn>1</mn></mtd></mtr></mtable><mo>)</mo></mrow></math>"),
    "(\\begin{matrix}1 & 0 \\\\ 0 & 1\\end{matrix})",
  );
});

test("prefers the TeX source a formula carries", () => {
  assert.equal(
    mathToTex('<math alttext="{\\displaystyle P^{-1}AP=D}"><semantics><mi>P</mi></semantics></math>'),
    "P^{-1}AP=D",
  );
  assert.equal(
    mathToTex('<math><semantics><mi>A</mi><annotation encoding="application/x-tex">{\\displaystyle A}</annotation></semantics></math>'),
    "A",
  );
});

test("htmlToText keeps formulas as $…$ and escapes literal dollars", () => {
  const html =
    '<p>In linear algebra, a square matrix <span><math alttext="{\\displaystyle A}"><mi>A</mi></math></span>&#160;is called <b>diagonalizable</b>.</p><p>It costs US$5.</p>';
  assert.equal(htmlToText(html), "In linear algebra, a square matrix $A$ is called diagonalizable. It costs US\\$5.");
});
