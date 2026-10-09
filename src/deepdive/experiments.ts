import { useSyncExternalStore } from "react";
import type { DiveContextStrategy } from "../grounding/context.ts";
import { DEV_MODE } from "../devMode.ts";

// Deep Dive experiments: each one a switch, off by default, so the shipped
// dive is exactly what it was before any of them existed. They're kept
// independent (none requires another) so an eval can compare them one at a
// time or in any combination — the pure functions they change take the same
// flags as plain options (see grounding/context.ts's DiveContextStrategy),
// never read them from here.

export interface DiveExperiments {
  // ---- Context: what the model is given ----
  localWindow: boolean; // the argument leading up to the selection, not just its chunk
  linkedSources: boolean; // equations, theorems, citations, symbols and terms the selection names
  rankingPriors: boolean; // retrieval favors the selection's section, skips index/contents/bibliography
  areaContext: boolean; // area dives locate the text in and around the region
  nestedContext: boolean; // nested dives resolve their selection to the document, anchored to the root passage
  readerNotes: boolean; // glossary definitions and the reader's own notes near the selection, as hints
  stableSources: boolean; // follow-ups keep the first answer's sources (same labels; a prompt-cache hit)
  // ---- Answers ----
  orientationFirst: boolean; // a brief orientation first, fuller explanations on follow-ups
  keepOpeningAnswer: boolean; // follow-ups always resend the first answer
  suggestions: boolean; // suggested follow-ups and dives after every answer
  diagrams: boolean; // "Diagram" on an answer: a flow diagram of it
  // ---- Navigation ----
  rootAnchor: boolean; // nested dives show and tie back to the passage the tree started from
  diveMap: boolean; // an outline of the whole dive tree
  treeSummary: boolean; // a one-page summary of a dive tree
}

export type DiveExperimentKey = keyof DiveExperiments;

export const DEFAULT_EXPERIMENTS: DiveExperiments = {
  localWindow: false,
  linkedSources: false,
  rankingPriors: false,
  areaContext: false,
  nestedContext: false,
  readerNotes: false,
  stableSources: false,
  orientationFirst: false,
  keepOpeningAnswer: false,
  suggestions: false,
  diagrams: false,
  rootAnchor: false,
  diveMap: false,
  treeSummary: false,
};

// What the settings menu shows, in groups.
export const EXPERIMENT_GROUPS: { title: string; items: { key: DiveExperimentKey; label: string; hint: string }[] }[] = [
  {
    title: "Context",
    items: [
      { key: "localWindow", label: "Wider local context", hint: "Send the argument leading up to the selection, extended to the start of a proof or theorem." },
      { key: "linkedSources", label: "Follow references", hint: "Add the equations, theorems, figures, citations, symbols and terms the selection names." },
      { key: "rankingPriors", label: "Section-aware ranking", hint: "Prefer passages from the selection's section; skip index, contents and bibliography pages." },
      { key: "areaContext", label: "Area dives: read around the region", hint: "Use the text inside and around an area selection, and a figure's caption." },
      { key: "nestedContext", label: "Nested dives search the document", hint: "Resolve a nested selection to where the document defines it, anchored to the original passage." },
      { key: "readerNotes", label: "Glossary and your notes", hint: "Give the model glossary definitions and your highlight notes near the selection, as hints." },
      { key: "stableSources", label: "Stable follow-up sources", hint: "Follow-ups keep the first answer's sources and add new ones after them." },
    ],
  },
  {
    title: "Answers",
    items: [
      { key: "orientationFirst", label: "Orientation first", hint: "A brief first answer (what it says, what leads to it, its role); fuller explanations on follow-ups." },
      { key: "keepOpeningAnswer", label: "Remember the first answer", hint: "Follow-ups always resend the dive's first answer, not just the last two exchanges." },
      { key: "suggestions", label: "Suggested dives", hint: "Follow-up questions and concepts to dive into, as pills after every answer." },
      { key: "diagrams", label: "Diagrams", hint: "A Diagram button on answers that draws the explanation as a flow diagram." },
    ],
  },
  {
    title: "Navigation",
    items: [
      { key: "rootAnchor", label: "Original passage in view", hint: "Nested dives show the passage the tree started from, and tie their answer back to it." },
      { key: "diveMap", label: "Dive map", hint: "An outline of every dive in the tree." },
      { key: "treeSummary", label: "Tree summary", hint: "A one-page summary of everything explored from one passage." },
    ],
  },
];

// The context experiments, as the options grounding/context.ts takes.
export function contextStrategy(experiments: DiveExperiments): DiveContextStrategy {
  const { localWindow, linkedSources, rankingPriors, areaContext, nestedContext } = experiments;
  return { localWindow, linkedSources, rankingPriors, areaContext, nestedContext };
}

const STORAGE_KEY = "musereader-dive-experiments";

// Unknown keys are dropped and missing ones take their default, so a flag
// added or removed later never breaks what was saved.
export function parseExperiments(raw: string | null): DiveExperiments {
  const result = { ...DEFAULT_EXPERIMENTS };
  if (!raw) return result;
  try {
    const saved = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_EXPERIMENTS) as DiveExperimentKey[]) {
      if (typeof saved[key] === "boolean") result[key] = saved[key] as boolean;
    }
  } catch {
    // Unreadable: defaults.
  }
  return result;
}

let current: DiveExperiments | null = null;
const listeners = new Set<() => void>();

// Outside dev mode every experiment is off, whatever was saved: the menu
// that switches them isn't shown there, so a saved choice couldn't be undone.
// What was saved is left alone for the next time dev mode is on.
export function getExperiments(): DiveExperiments {
  if (!DEV_MODE) return DEFAULT_EXPERIMENTS;
  if (!current) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Storage unavailable: defaults.
    }
    current = parseExperiments(raw);
  }
  return current;
}

export function setExperiments(next: Partial<DiveExperiments>) {
  current = { ...getExperiments(), ...next };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Non-fatal: the choice just won't persist.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useExperiments(): DiveExperiments {
  return useSyncExternalStore(subscribe, getExperiments, getExperiments);
}
