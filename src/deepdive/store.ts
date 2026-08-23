import type { DivePanel, Pin } from "./types";

function keyForFile(prefix: string, file: File): string {
  return `${prefix}:${file.name}:${file.size}:${file.lastModified}`;
}

export function divesKeyForFile(file: File): string {
  return keyForFile("pdf-dives", file);
}

export function pinsKeyForFile(file: File): string {
  return keyForFile("pdf-pins", file);
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
