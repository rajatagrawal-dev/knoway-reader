import { useSyncExternalStore } from "react";
import { keyForFile } from "../deepdive/store";
import type { GlossaryEntry } from "./types";

export function glossaryKeyForFile(file: File): string {
  return keyForFile("pdf-glossary", file);
}

// Glossary entries live outside React state, in a subscribable store: the
// definition card is rendered inside react-pdf-highlighter's selection tip,
// whose content is captured once when the selection is made — a prop from
// App would never update there, but a subscription does, so the card can
// show the definition streaming in. The sidebar panel reads the same store.
export class GlossaryStore {
  private entries: GlossaryEntry[] = [];
  private storageKey: string | null = null;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.entries;

  load(storageKey: string) {
    this.storageKey = storageKey;
    let loaded: GlossaryEntry[] = [];
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) loaded = JSON.parse(raw) as GlossaryEntry[];
    } catch {
      loaded = [];
    }
    // A lookup still running when the app closed can't resume; offer a retry.
    this.entries = loaded.map((entry) =>
      entry.status === "pending" || entry.status === "streaming"
        ? { ...entry, status: "error", error: "Interrupted before it finished." }
        : entry,
    );
    this.emit();
  }

  get(id: string): GlossaryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  findByKey(key: string): GlossaryEntry | undefined {
    return this.entries.find((entry) => entry.key === key);
  }

  add(entry: GlossaryEntry) {
    this.entries = [entry, ...this.entries];
    this.commit();
  }

  // `persist: false` for the many small updates while a definition streams
  // in — the job persists once when it settles.
  update(id: string, patch: Partial<GlossaryEntry>, { persist = true } = {}) {
    this.entries = this.entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    if (persist) this.commit();
    else this.emit();
  }

  remove(id: string) {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.commit();
  }

  private commit() {
    if (this.storageKey) {
      try {
        localStorage.setItem(this.storageKey, JSON.stringify(this.entries));
      } catch {
        // Over quota: keep working in memory rather than failing the lookup.
      }
    }
    this.emit();
  }

  private emit() {
    this.listeners.forEach((listener) => listener());
  }
}

export function useGlossaryEntries(store: GlossaryStore): GlossaryEntry[] {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

export function useGlossaryEntry(store: GlossaryStore, id: string | null): GlossaryEntry | undefined {
  const entries = useGlossaryEntries(store);
  return id ? entries.find((entry) => entry.id === id) : undefined;
}
