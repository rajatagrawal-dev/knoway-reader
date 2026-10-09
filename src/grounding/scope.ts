import { sectionPageRange, sectionPathAt, type Section } from "../text/sections.ts";
import type { AskScope } from "./ask.ts";

// Which part of the document a question is about, read from the question
// itself — so the reader never has to pick one. "this page", "page 42",
// "pp. 12–15", "this chapter", "section 3.2", "chapter 4"; anything else is
// about the whole document, where relevance ranking finds the right
// passages on its own.

export interface ScopeContext {
  currentPage: number;
  numPages: number;
  sections: Section[];
  pageLabels: string[] | null;
}

// A page as the reader names it: its printed label ("xii", "42") when the
// PDF has labels, else its number.
function pageFromLabel(label: string, context: ScopeContext): number | null {
  const byLabel = context.pageLabels?.findIndex((l) => l.toLowerCase() === label.toLowerCase()) ?? -1;
  if (byLabel !== -1) return byLabel + 1;
  const n = Number(label);
  return Number.isInteger(n) && n >= 1 && n <= context.numPages ? n : null;
}

function sectionScope(section: Section, context: ScopeContext): AskScope {
  const [from, to] = sectionPageRange(context.sections, context.sections.indexOf(section), context.numPages);
  return { kind: "section", title: section.title, from, to };
}

// "Chapter 3", "section 3.2", "part II": the outline entry numbered so.
function numberedSection(word: string, number: string, context: ScopeContext): Section | null {
  const escaped = number.replace(/\./g, "\\.");
  // A bare number may stand alone ("3 Entanglement"); a letter or roman
  // numeral needs its word ("Appendix A"), or it would match any title
  // starting with that letter.
  const prefix = /^\d/.test(number) ? `(?:${word}\\s+)?` : `${word}\\s+`;
  const titled = new RegExp(`^${prefix}${escaped}(?![\\w.])`, "i");
  const candidates = context.sections.filter((section) => titled.test(section.title.trim()));
  if (candidates.length === 0) return null;
  // "Chapter 3" prefers a top-level entry; "section 3.2" the exact one.
  return candidates.sort((a, b) => a.depth - b.depth)[0];
}

const PAGE_LABEL = "([0-9]+|[ivxlcdm]+)";

export function inferScope(question: string, context: ScopeContext): AskScope {
  const q = question.toLowerCase();

  // A page range: "pages 12-15", "pp. 12–15", "p. 12 to 15".
  const range = new RegExp(`\\b(?:pages?|pp?\\.)\\s*${PAGE_LABEL}\\s*(?:-|–|—|to|through)\\s*${PAGE_LABEL}\\b`, "i").exec(q);
  if (range) {
    const from = pageFromLabel(range[1], context);
    const to = pageFromLabel(range[2], context);
    if (from && to && to >= from) {
      return { kind: "section", title: `pp. ${range[1]}–${range[2]}`, from, to };
    }
  }

  // One page: "page 42", "p. 42", "on p 42".
  const single = new RegExp(`\\b(?:page|p\\.?)\\s*${PAGE_LABEL}\\b`, "i").exec(q);
  if (single) {
    const page = pageFromLabel(single[1], context);
    if (page) return { kind: "page", page };
  }

  if (/\b(?:this|current|the current) page\b|\bon (?:the|this) page\b/.test(q)) {
    return { kind: "page", page: context.currentPage };
  }

  const path = sectionPathAt(context.sections, context.currentPage);
  if (/\bthis chapter\b|\bcurrent chapter\b|\bthe chapter i'?m (?:reading|on)\b/.test(q) && path[0]) {
    return sectionScope(path[0], context);
  }
  if (/\b(?:this|current) (?:section|subsection|part)\b/.test(q) && path.length) {
    return sectionScope(path[path.length - 1], context);
  }

  const named = /\b(chapter|section|part|appendix)\s+([0-9]+(?:\.[0-9]+)*|[ivxlcdm]+|[a-z])\b/i.exec(question);
  if (named) {
    const section = numberedSection(named[1], named[2], context);
    if (section) return sectionScope(section, context);
  }

  return { kind: "document" };
}
