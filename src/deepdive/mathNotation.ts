// The model is told to always wrap math in LaTeX and to put substantial
// equations on their own $$...$$ line, but doesn't reliably comply —
// especially for equations mentioned mid-sentence. These are deterministic
// backstops applied to every turn's raw markdown before rendering:
//
//  - promoteSubstantialInlineMath: the model sometimes correctly wraps a
//    real equation in $...$ but leaves it inline rather than using $$...$$.
//    Upgrades any single-dollar span with an "=" and enough content to be
//    "an equation" (not just a bare variable) to its own $$...$$ line.
//  - promoteInlineEquations: finds a run of equation-looking tokens (Greek
//    letters, superscripts, kets, an "=" sign) embedded in a sentence with
//    no $ wrapping at all, and promotes the whole run to its own $$...$$
//    block, so it reads as a formal display equation instead of clutter.
//    An "=" isn't required when the run contains an unambiguous math-only
//    signal (kets, √/\sqrt) — those never appear in ordinary prose, unlike
//    a bare "=" or "|", so a state vector like "(|0⟩+|1⟩)/√2" mentioned
//    with no equation around it still gets promoted.
//  - convertUnicodeSqrt: the model sometimes writes a literal "√" instead
//    of "\sqrt{...}", including inside spans it already wrapped in $...$.
//    KaTeX renders raw "√" as a bare \surd glyph with no bar over its
//    argument, which looks broken — so this rewrites "√2"/"√(x+y)" to
//    "\sqrt{2}"/"\sqrt{x+y}" everywhere, before the $-wrapping passes run.
//  - autoWrapCaretExponents: catches whatever's left — a standalone
//    "base^exponent" mentioned in passing with no "=" nearby — and wraps
//    just that piece as inline LaTeX so the exponent still renders as a
//    real superscript.
//
// All three skip content already inside $$...$$/`...` (and, other than the
// first, $...$) so they never touch math or code the model already
// formatted the way we want.

const GREEK_TO_LATEX: Record<string, string> = {
  α: "\\alpha", β: "\\beta", γ: "\\gamma", δ: "\\delta", ε: "\\epsilon",
  ζ: "\\zeta", η: "\\eta", θ: "\\theta", ι: "\\iota", κ: "\\kappa",
  λ: "\\lambda", μ: "\\mu", ν: "\\nu", ξ: "\\xi", π: "\\pi",
  ρ: "\\rho", σ: "\\sigma", τ: "\\tau", υ: "\\upsilon", φ: "\\varphi",
  χ: "\\chi", ψ: "\\psi", ω: "\\omega",
  Γ: "\\Gamma", Δ: "\\Delta", Θ: "\\Theta", Λ: "\\Lambda", Ξ: "\\Xi",
  Π: "\\Pi", Σ: "\\Sigma", Φ: "\\Phi", Ψ: "\\Psi", Ω: "\\Omega",
};

const SUPERSCRIPT_TO_LATEX: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
  "⁺": "+", "⁻": "-", "⁽": "(", "⁾": ")", "ⁱ": "i", "ⁿ": "n",
};

const MATH_FUNCTION_WORDS = new Set([
  "cos", "sin", "tan", "cot", "sec", "csc",
  "log", "ln", "exp", "sqrt", "lim", "max", "min", "det", "tr",
]);

// Greek letters, superscript/subscript digits, angle-bracket kets, and "|"
// (used for bra-ket bars and absolute value) — strong, low-false-positive
// signals that a token is part of an equation rather than English prose.
const TRIGGER = /[Ͱ-Ͽ⁰-₟⟨⟩|]/;
const DIGIT_OR_SYMBOL = /[0-9Ͱ-Ͽ⁰-₟⟨⟩|]/;
const LONE_OPERATOR = new Set(["-", "+", "*", "/", "="]);

// Kets and \sqrt are unambiguous math-only signals (unlike a bare "=" or
// "|", which can show up in prose or markdown tables) — their presence
// alone is enough to promote a run, no "=" required.
const STRONG_MATH_SIGNAL = /⟨|⟩|\\sqrt/;

const PROTECTED_SPAN = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|`[^`\n]+?`)/g;

// Matches a literal Unicode "√" followed by its argument — either a
// parenthesized group or a run of letters/digits — so "√2" and "√(x+y)"
// become "\sqrt{2}" and "\sqrt{x+y}". Runs on the raw markdown (including
// inside $...$/$$...$$ the model already wrote) since it never adds or
// removes a "$", so it can't desync the dollar-balance check.
const UNICODE_SQRT = /√(\([^()\n]{1,80}\)|[\p{L}\p{N}]{1,20})/gu;

export function convertUnicodeSqrt(markdown: string): string {
  return markdown.replace(UNICODE_SQRT, (_match, arg: string) => {
    const inner = arg.startsWith("(") ? arg.slice(1, -1) : arg;
    return `\\sqrt{${inner}}`;
  });
}

function isEquationToken(token: string): boolean {
  if (LONE_OPERATOR.has(token)) return true;
  if (DIGIT_OR_SYMBOL.test(token)) return true;
  if (token.includes("=")) return true;
  if (STRONG_MATH_SIGNAL.test(token)) return true;
  const bare = token.replace(/[^A-Za-z]/g, "").toLowerCase();
  return Boolean(bare && MATH_FUNCTION_WORDS.has(bare));
}

function convertGreekAndSuperscript(str: string): string {
  let out = "";
  const chars = Array.from(str);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (GREEK_TO_LATEX[ch]) {
      out += GREEK_TO_LATEX[ch];
      if (next && /[A-Za-z]/.test(next)) out += " "; // avoid merging into the next command name
      continue;
    }
    if (SUPERSCRIPT_TO_LATEX[ch]) {
      out += `^{${SUPERSCRIPT_TO_LATEX[ch]}}`;
      continue;
    }
    if (ch === "⟨") { out += "\\langle"; continue; }
    if (ch === "⟩") { out += "\\rangle"; continue; }
    out += ch;
  }
  return out;
}

// Converts one equation-run token to LaTeX. A caret's exponent gets {}
// bracing — a raw "e^ix" would otherwise only superscript the "i".
function toLatexToken(token: string): string {
  const caretIndex = token.indexOf("^");
  if (caretIndex === -1) return convertGreekAndSuperscript(token);
  const base = token.slice(0, caretIndex);
  let exponent = token.slice(caretIndex + 1);
  if (exponent.startsWith("(") && exponent.endsWith(")")) exponent = exponent.slice(1, -1);
  // Already brace-delimited (e.g. the model wrote "x^{2}" plain, with no $
  // at all) — don't wrap it again into "^{{2}}".
  if (exponent.startsWith("{") && exponent.endsWith("}")) {
    return `${convertGreekAndSuperscript(base)}^${convertGreekAndSuperscript(exponent)}`;
  }
  return `${convertGreekAndSuperscript(base)}^{${convertGreekAndSuperscript(exponent)}}`;
}

function splitTrailingPunctuation(word: string): { core: string; trail: string } {
  const match = word.match(/^(.*?)([.,;:!?]+)$/);
  return match ? { core: match[1], trail: match[2] } : { core: word, trail: "" };
}

function promoteInlineEquationsInSegment(text: string): string {
  if (!text.includes("=") && !STRONG_MATH_SIGNAL.test(text)) return text;

  const words = text.split(" ");
  const runs: { start: number; end: number }[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isEquationToken(words[i])) {
      i++;
      continue;
    }
    let j = i;
    let hasEquals = false;
    let hasTrigger = false;
    let hasStrong = false;
    while (j < words.length && isEquationToken(words[j])) {
      if (words[j].includes("=")) hasEquals = true;
      if (TRIGGER.test(words[j])) hasTrigger = true;
      if (STRONG_MATH_SIGNAL.test(words[j])) hasStrong = true;
      j++;
    }
    if (hasStrong || (hasEquals && hasTrigger && j - i >= 2)) {
      runs.push({ start: i, end: j });
    }
    i = j;
  }
  if (runs.length === 0) return text;

  const parts: string[] = [];
  let cursor = 0;
  for (const run of runs) {
    parts.push(words.slice(cursor, run.start).join(" "));
    const equationWords = words.slice(run.start, run.end);
    const lastIndex = equationWords.length - 1;
    const { core, trail } = splitTrailingPunctuation(equationWords[lastIndex]);
    equationWords[lastIndex] = core;
    const latex = equationWords.filter((w) => w.length > 0).map(toLatexToken).join(" ");
    parts.push(`\n\n$$${latex}$$${trail}\n\n`);
    cursor = run.end;
  }
  parts.push(words.slice(cursor).join(" "));
  return parts.join(" ").replace(/ *\n\n */g, "\n\n").trim();
}

export function promoteInlineEquations(markdown: string): string {
  return markdown
    .split(PROTECTED_SPAN)
    .map((part, index) => (index % 2 === 1 ? part : promoteInlineEquationsInSegment(part)))
    .join("");
}

const CARET_EXPONENT = /([\p{L}\p{N}]+|\([^()\n]{1,40}\))\^(\([^()\n]{1,40}\)|[\p{L}\p{N}]{1,20})/gu;

export function autoWrapCaretExponents(markdown: string): string {
  return markdown
    .split(PROTECTED_SPAN)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(CARET_EXPONENT, (_match, base: string, exponent: string) => {
        const clean = exponent.startsWith("(") ? exponent.slice(1, -1) : exponent;
        return `$${base}^{${clean}}$`;
      });
    })
    .join("");
}

// Matches a single-dollar span without touching $$...$$ (negative
// lookbehind/lookahead ensure neither delimiter is adjacent to another $).
const SINGLE_DOLLAR_SPAN = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;

function isSubstantialEquation(inner: string): boolean {
  return inner.includes("=") && inner.trim().length > 12;
}

export function promoteSubstantialInlineMath(markdown: string): string {
  return markdown.replace(SINGLE_DOLLAR_SPAN, (match, inner: string) => {
    if (!isSubstantialEquation(inner)) return match;
    return `\n\n$$${inner.trim()}$$\n\n`;
  });
}

// A single stray/mismatched $ (e.g. the model drops one character from a
// closing $$, or uses $ as a literal currency sign) makes remark-math hunt
// for the next available delimiter to pair it with — however far away that
// is — swallowing everything in between into one nonsense "equation" that
// KaTeX then fails to parse, rendering a huge garbled error block instead
// of the rest of the message. Counting $$ and $ tokens (outside code
// spans) catches this: either count coming out odd means something is
// unpaired somewhere. There's no reliable way to know which one, so the
// whole message's $ signs are escaped — degrading to plain, readable text
// instead of risking a corrupted render.
const DOLLAR_TOKEN = /(`[^`\n]*`|\$\$|\$)/g;

function hasBalancedDollarDelimiters(markdown: string): boolean {
  let doubleCount = 0;
  let singleCount = 0;
  for (const token of markdown.split(DOLLAR_TOKEN)) {
    if (token === "$$") doubleCount++;
    else if (token === "$") singleCount++;
  }
  return doubleCount % 2 === 0 && singleCount % 2 === 0;
}

export function normalizeMathNotation(markdown: string): string {
  // Fix literal "√" first — it never touches a "$", so it's safe to run
  // before the balance check and applies equally to already-$-wrapped math
  // (which the promotion passes below leave untouched) and bare prose.
  markdown = convertUnicodeSqrt(markdown);
  // Check balance on the *raw* content before running any promotion pass.
  // Those passes assume $ signs are already sanely paired — they use them
  // to identify "this span is already math, leave it alone." If a
  // delimiter is malformed (e.g. the model drops one character from a
  // closing $$) they can end up sweeping the dangling delimiter into a
  // *newly* promoted $$...$$ wrap, which can coincidentally restore even
  // parity while leaving the pairing nonsensical — masking the exact
  // problem the balance check exists to catch. Bailing out here, before
  // any of that runs, guarantees a safe (if plain) fallback.
  if (!hasBalancedDollarDelimiters(markdown)) {
    return markdown.replace(/\$/g, "\\$");
  }
  const upgraded = promoteSubstantialInlineMath(markdown);
  const normalized = autoWrapCaretExponents(promoteInlineEquations(upgraded));
  // Defense in depth: the passes above are expected to preserve balance on
  // already-balanced input, but if a bug in them ever breaks that
  // invariant, fail safe here too rather than handing KaTeX something
  // broken.
  if (!hasBalancedDollarDelimiters(normalized)) {
    return markdown.replace(/\$/g, "\\$");
  }
  return normalized;
}
