import type { DiveHighlight, DivePanel, GeneralNote, Pin } from "./types";

export function keyForFile(prefix: string, file: File): string {
  return `${prefix}:${file.name}:${file.size}:${file.lastModified}`;
}

export function divesKeyForFile(file: File): string {
  return keyForFile("pdf-dives", file);
}

export function pinsKeyForFile(file: File): string {
  return keyForFile("pdf-pins", file);
}

export function diveHighlightsKeyForFile(file: File): string {
  return keyForFile("pdf-dive-highlights", file);
}

export function generalNotesKeyForFile(file: File): string {
  return keyForFile("pdf-general-notes", file);
}

export function loadDivePanels(key: string): DivePanel[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as DivePanel[];
  } catch {
    return [];
  }
}

export function saveDivePanels(key: string, panels: DivePanel[]) {
  try {
    localStorage.setItem(key, JSON.stringify(panels));
  } catch {
    // Area-highlight dives embed a base64 screenshot per root panel, which
    // can push a long dive history over the ~5-10MB localStorage quota.
    // Losing persistence is better than crashing the render effect that
    // calls this on every panel update.
  }
}

export function loadPins(key: string): Pin[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as Pin[];
  } catch {
    return [];
  }
}

export function savePins(key: string, pins: Pin[]) {
  localStorage.setItem(key, JSON.stringify(pins));
}

export function loadDiveHighlights(key: string): DiveHighlight[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as DiveHighlight[];
  } catch {
    return [];
  }
}

export function saveDiveHighlights(key: string, highlights: DiveHighlight[]) {
  localStorage.setItem(key, JSON.stringify(highlights));
}

export function loadGeneralNotes(key: string): GeneralNote[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as GeneralNote[];
  } catch {
    return [];
  }
}

export function saveGeneralNotes(key: string, notes: GeneralNote[]) {
  localStorage.setItem(key, JSON.stringify(notes));
}
