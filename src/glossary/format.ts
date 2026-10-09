import type { GlossaryEntry, GlossaryOrigin } from "./types";

// What's happening with a lookup that hasn't produced a definition yet.
export function lookupStatusText(entry: GlossaryEntry): string {
  if (entry.status === "pending" && entry.refCount === 0) return "Searching the document…";
  const found = entry.refCount === 0 ? "No exact matches" : `Found ${entry.refCount} reference${entry.refCount === 1 ? "" : "s"}`;
  return `${found} · writing definition…`;
}

export function refCountText(count: number): string {
  return `${count} reference${count === 1 ? "" : "s"}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The origin chip's text: "Common English word", "Latin phrase",
// "Quantum computing term", "Name · person", "Physics abbreviation".
export function originLabel(origin: GlossaryOrigin, term: string): string {
  const unit = /\s/.test(term.trim()) ? "phrase" : "word";
  const detail = origin.detail ? capitalize(origin.detail) : "";
  switch (origin.kind) {
    case "common":
      return detail ? `Common ${detail} ${unit}` : `Common ${unit}`;
    case "foreign":
      return detail ? `${detail} ${unit}` : `Foreign ${unit}`;
    case "technical":
      return detail ? `${detail} term` : "Technical term";
    case "name":
      return origin.detail ? `Name · ${origin.detail}` : "Name";
    case "abbreviation":
      return detail ? `${detail} abbreviation` : "Abbreviation";
  }
}

// A reference's text (server/reference.js) is plain text with its formulas
// as $…$ and literal dollar signs as \$. As markdown, the text between
// formulas is escaped so it reads as written, and a literal dollar becomes
// an entity — the math renderer would count "\$" as an unpaired delimiter.
const LITERAL_DOLLAR = "\u0000";

export function referenceMarkdown(text: string): string {
  return text
    .replace(/\\\$/g, LITERAL_DOLLAR)
    .split(/(\$[^$\n]+\$)/)
    .map((part, i) =>
      i % 2 === 1
        ? part.replaceAll(LITERAL_DOLLAR, "\\$")
        : part
            .replace(/[\\`*_[\]<>#|~]/g, "\\$&")
            .replace(/^(\s*)(\d+)\.(?=\s)/, "$1$2\\.")
            .replace(/^(\s*)([-+])(?=\s)/, "$1\\$2")
            .replaceAll(LITERAL_DOLLAR, "&#36;"),
    )
    .join("");
}
