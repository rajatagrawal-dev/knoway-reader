import type { DocDataKind, LibraryStorage } from "./types.ts";

const DEBOUNCE_MS = 300;

interface Pending {
  docId: string;
  kind: DocDataKind;
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
}

// Coalesces the app's frequent state changes into one write per document
// and kind: typing a comment or streaming a dive reply changes state many
// times a second, and each change would otherwise rewrite the whole file.
// Unchanged values (by reference) are never written — so re-saving what was
// just loaded costs nothing.
export class DocDataWriter {
  private pending = new Map<string, Pending>();
  private last = new Map<string, unknown>();
  private storage: LibraryStorage;
  private onError: (error: unknown) => void;

  constructor(storage: LibraryStorage, onError: (error: unknown) => void = console.error) {
    this.storage = storage;
    this.onError = onError;
  }

  // Records a value as already stored (e.g. just loaded), so scheduling that
  // same value doesn't write it back.
  prime(docId: string, kind: DocDataKind, value: unknown) {
    this.last.set(`${docId}/${kind}`, value);
  }

  schedule(docId: string, kind: DocDataKind, value: unknown) {
    const key = `${docId}/${kind}`;
    const existing = this.pending.get(key);
    if (existing) clearTimeout(existing.timer);
    else if (this.last.get(key) === value) return;
    const timer = setTimeout(() => void this.write(key), DEBOUNCE_MS);
    this.pending.set(key, { docId, kind, value, timer });
  }

  // Writes everything scheduled now — before switching documents, and when
  // the page is going away.
  async flush(): Promise<void> {
    await Promise.all(
      [...this.pending.entries()].map(([key, { timer }]) => {
        clearTimeout(timer);
        return this.write(key);
      }),
    );
  }

  private async write(key: string) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.last.set(key, entry.value);
    try {
      await this.storage.putData(entry.docId, entry.kind, entry.value);
    } catch (error) {
      // Not written after all: forget it as stored, so the next change
      // retries rather than being skipped as unchanged.
      if (this.last.get(key) === entry.value) this.last.delete(key);
      this.onError(error);
    }
  }
}
