// MathML → LaTeX, for the formulas in Wikimedia content. Wikipedia's HTML
// carries each formula's TeX source (alttext, or an x-tex annotation) and
// that's used when present; Wiktionary's definition API sends bare
// Presentation MathML, which is converted here. The subset Wikimedia's
// math renderer produces is small — tokens, rows, scripts, fractions,
// roots, accents, tables — so this is a direct tree walk, no general XML.

const SYMBOLS = {
  "−": "-", "∗": "*", "×": "\\times", "·": "\\cdot", "⋅": "\\cdot", "÷": "\\div", "±": "\\pm", "∓": "\\mp",
  "≤": "\\le", "≥": "\\ge", "≠": "\\ne", "≈": "\\approx", "≡": "\\equiv", "∼": "\\sim", "≅": "\\cong", "∝": "\\propto",
  "→": "\\to", "←": "\\leftarrow", "↔": "\\leftrightarrow", "⇒": "\\Rightarrow", "⇔": "\\Leftrightarrow", "↦": "\\mapsto",
  "∞": "\\infty", "∂": "\\partial", "∇": "\\nabla", "∈": "\\in", "∉": "\\notin", "⊂": "\\subset", "⊆": "\\subseteq",
  "∪": "\\cup", "∩": "\\cap", "∅": "\\emptyset", "∀": "\\forall", "∃": "\\exists", "¬": "\\neg", "∧": "\\land", "∨": "\\lor",
  "∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∮": "\\oint", "√": "\\surd",
  "⟨": "\\langle", "⟩": "\\rangle", "⌈": "\\lceil", "⌉": "\\rceil", "⌊": "\\lfloor", "⌋": "\\rfloor", "‖": "\\|",
  "⊗": "\\otimes", "⊕": "\\oplus", "†": "\\dagger", "∘": "\\circ", "…": "\\ldots", "⋯": "\\cdots", "′": "'",
  "ℏ": "\\hbar", "ℓ": "\\ell", "ℝ": "\\mathbb{R}", "ℂ": "\\mathbb{C}", "ℕ": "\\mathbb{N}", "ℤ": "\\mathbb{Z}", "ℚ": "\\mathbb{Q}",
  "{": "\\{", "}": "\\}", "#": "\\#", "%": "\\%", "&": "\\&", "_": "\\_", "$": "\\$", "\u2061": "", "\u2062": "", "\u2063": "",
};

const GREEK = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ϵ: "epsilon", ζ: "zeta", η: "eta", θ: "theta",
  ϑ: "vartheta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu", ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma",
  ς: "varsigma", τ: "tau", υ: "upsilon", φ: "phi", ϕ: "phi", χ: "chi", ψ: "psi", ω: "omega",
  Γ: "Gamma", Δ: "Delta", Θ: "Theta", Λ: "Lambda", Ξ: "Xi", Π: "Pi", Σ: "Sigma", Υ: "Upsilon", Φ: "Phi", Ψ: "Psi", Ω: "Omega",
};

const FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "max", "min",
  "sup", "inf", "det", "dim", "ker", "deg", "gcd", "arg", "Pr",
]);

const ACCENTS = {
  "¯": "overline", "‾": "overline", "―": "overline", "_": "overline", "^": "hat", "ˆ": "hat", "~": "tilde", "˜": "tilde",
  "→": "vec", "⃗": "vec", "˙": "dot", "¨": "ddot", "ˇ": "check", "⏞": "overbrace",
};
const UNDER_ACCENTS = { "_": "underline", "¯": "underline", "‾": "underline", "⏟": "underbrace" };
const LARGE_OPERATORS = /^\\(sum|prod|int|oint|lim|max|min|sup|inf|bigcup|bigcap)$/;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// ---- A minimal parser for a <math> fragment ----

function parse(xml) {
  const root = { name: "#root", attrs: {}, children: [] };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const [, close, open, rawAttrs, selfClosing, text] of xml.matchAll(tokens)) {
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      top.children.push({ text: decodeEntities(text) });
    } else if (open) {
      const attrs = {};
      for (const [, key, dq, sq] of (rawAttrs ?? "").matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[key.toLowerCase()] = decodeEntities(dq ?? sq);
      }
      const node = { name: open.toLowerCase().replace(/^m:/, ""), attrs, children: [] };
      top.children.push(node);
      if (!selfClosing) stack.push(node);
    } else if (close) {
      const name = close.toLowerCase().replace(/^m:/, "");
      const at = stack.findLastIndex((node) => node.name === name);
      if (at > 0) stack.length = at;
    }
  }
  return root;
}

// ---- Conversion ----

const isCommand = (tex) => /^\\[a-zA-Z]+$/.test(tex);

// Concatenates TeX pieces, keeping "\alpha" + "b" from becoming "\alphab".
function join(pieces) {
  let out = "";
  for (const piece of pieces) {
    if (!piece) continue;
    if (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(piece)) out += " ";
    out += piece;
  }
  return out;
}

const group = (tex) => `{${tex}}`;
// A script's base: one symbol or command as is, anything longer grouped.
const base = (tex) => (tex.length <= 1 || isCommand(tex) ? tex : group(tex));

function textOf(node) {
  return node.text ?? node.children.map(textOf).join("");
}

function symbols(text) {
  return join(
    [...text.trim()].map((ch) => {
      if (GREEK[ch]) return `\\${GREEK[ch]}`;
      if (ch in SYMBOLS) return SYMBOLS[ch];
      return ch === "\\" ? "\\backslash" : ch;
    }),
  );
}

function element(node) {
  return node.children.filter((child) => !child.text || child.text.trim());
}

function convert(node) {
  if (node.text !== undefined) return symbols(node.text);
  const kids = element(node);
  const all = () => join(kids.map(convert));
  const arg = (i) => (kids[i] ? convert(kids[i]) : "");

  switch (node.name) {
    case "annotation":
    case "annotation-xml":
    case "mphantom":
    case "none":
    case "mprescripts":
      return "";
    case "semantics":
      return kids[0] ? convert(kids[0]) : "";
    case "mi": {
      const text = textOf(node).trim();
      if (text.length > 1 && /^[A-Za-z]+$/.test(text)) {
        return FUNCTIONS.has(text) ? `\\${text}` : `\\mathrm{${text}}`;
      }
      const tex = symbols(text);
      return node.attrs.mathvariant === "normal" && /^[A-Za-z]$/.test(text) ? `\\mathrm{${tex}}` : tex;
    }
    case "mn":
    case "mo":
      return symbols(textOf(node));
    case "mtext":
    case "ms": {
      const text = textOf(node).replace(/[\\{}$&#%_^~]/g, " ").replace(/\s+/g, " ");
      return text.trim() ? `\\text{${text}}` : "\\ ";
    }
    case "mspace":
      return "\\,";
    case "msup":
      return `${base(arg(0))}^${group(arg(1))}`;
    case "msub":
      return `${base(arg(0))}_${group(arg(1))}`;
    case "msubsup":
      return `${base(arg(0))}_${group(arg(1))}^${group(arg(2))}`;
    case "mfrac":
      return node.attrs.linethickness === "0" || node.attrs.linethickness === "0px"
        ? `\\binom${group(arg(0))}${group(arg(1))}`
        : `\\frac${group(arg(0))}${group(arg(1))}`;
    case "msqrt":
      return `\\sqrt${group(all())}`;
    case "mroot":
      return `\\sqrt[${arg(1)}]${group(arg(0))}`;
    case "mover":
    case "munder":
    case "munderover": {
      const inner = arg(0);
      if (node.name === "munderover") {
        return `${base(inner)}_${group(arg(1))}^${group(arg(2))}`;
      }
      const mark = textOf(kids[1] ?? { text: "" }).trim();
      const accent = (node.name === "mover" ? ACCENTS : UNDER_ACCENTS)[mark];
      if (accent) return `\\${accent}${group(inner)}`;
      if (LARGE_OPERATORS.test(inner)) return `${inner}${node.name === "mover" ? "^" : "_"}${group(arg(1))}`;
      return `\\${node.name === "mover" ? "overset" : "underset"}${group(arg(1))}${group(inner)}`;
    }
    case "mtable": {
      const rows = kids.map((row) => element(row).map(convert).join(" & "));
      return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
    }
    case "mfenced": {
      const open = node.attrs.open ?? "(";
      const close = node.attrs.close ?? ")";
      const separator = (node.attrs.separators ?? ",").trim()[0] ?? "";
      return `\\left${symbols(open) || "."}${kids.map(convert).join(separator)}\\right${symbols(close) || "."}`;
    }
    case "menclose":
      return /box|roundedbox/.test(node.attrs.notation ?? "") ? `\\boxed${group(all())}` : all();
    default:
      return all();
  }
}

// Wikipedia wraps every formula as {\displaystyle ...}; that's implied here.
function unwrapDisplayStyle(tex) {
  const match = tex.trim().match(/^\{\\displaystyle\s*([\s\S]*)\}$/);
  return (match ? match[1] : tex).trim();
}

// One <math>…</math> element as LaTeX — its TeX source when it carries
// one, else converted from its MathML.
export function mathToTex(xml) {
  const root = parse(xml);
  const math = root.children.find((child) => child.name === "math") ?? root;
  if (math.attrs?.alttext) return unwrapDisplayStyle(math.attrs.alttext);
  const findAnnotation = (node) =>
    node.name === "annotation" && /tex/i.test(node.attrs.encoding ?? "")
      ? node
      : (node.children ?? []).map(findAnnotation).find(Boolean);
  const annotation = findAnnotation(math);
  if (annotation) return unwrapDisplayStyle(textOf(annotation));
  return convert(math).replace(/\s+/g, " ").trim();
}

// An HTML fragment as plain text, but with each <math> element as $…$
// (inline LaTeX, as the glossary's markdown renders it) and every literal
// dollar sign escaped as \$, so text and math can be told apart.
export function htmlToText(html) {
  const plain = (fragment) =>
    decodeEntities(fragment.replace(/<\/?(?:p|br|li|dd|dt|div|tr|td|h\d)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, ""))
      .replace(/\$/g, "\\$");
  let out = "";
  let last = 0;
  for (const match of html.matchAll(/<math\b[\s\S]*?<\/math>/gi)) {
    out += plain(html.slice(last, match.index));
    const tex = mathToTex(match[0]).replace(/\s+/g, " ");
    if (tex) out += `$${tex}$`;
    last = match.index + match[0].length;
  }
  // Word joiners and zero-width spaces Wikipedia sets around formulas.
  return (out + plain(html.slice(last)))
    .replace(/[\u200b\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
