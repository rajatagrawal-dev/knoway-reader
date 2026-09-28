import type { GlossaryEntry } from "./types";

// What's happening with a lookup that hasn't produced a definition yet.
export function lookupStatusText(entry: GlossaryEntry): string {
  if (entry.status === "pending" && entry.refCount === 0) return "Searching the document…";
  const found = entry.refCount === 0 ? "No exact matches" : `Found ${entry.refCount} reference${entry.refCount === 1 ? "" : "s"}`;
  return `${found} · writing definition…`;
}

export function refCountText(count: number): string {
  return `${count} reference${count === 1 ? "" : "s"}`;
}
