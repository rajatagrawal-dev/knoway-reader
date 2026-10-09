import { useLayoutEffect, useRef } from "react";
import { BookA, Check, ChevronRight, RotateCw } from "lucide-react";
import { useGlossaryEntry, type GlossaryStore } from "./store";
import { GlossaryMeaning, OriginBadge } from "./GlossaryParts";
import { lookupStatusText, refCountText } from "./format";
import type { GlossaryRef } from "./types";

interface GlossaryCardProps {
  store: GlossaryStore;
  entryId: string;
  onOpenInGlossary: (entryId: string) => void;
  onRetry: (entryId: string) => void;
  // "Defined on p. 12": to the passage that defines the term.
  onJumpToRef?: (ref: GlossaryRef) => void;
  pageLabel?: (pageNumber: number) => string; // the book's own page labels
  // The card grows as the definition streams in; its host re-positions it.
  onLayoutChange?: () => void;
}

// What the selection tip turns into after "Add to glossary": the definition
// streaming in right next to the selected text, so the reader never has to
// leave their place to see it. The entry is already saved to the glossary
// panel by the time this appears.
export default function GlossaryCard({
  store,
  entryId,
  onOpenInGlossary,
  onRetry,
  onJumpToRef,
  pageLabel = String,
  onLayoutChange,
}: GlossaryCardProps) {
  const entry = useGlossaryEntry(store, entryId);
  const onLayoutChangeRef = useRef(onLayoutChange);
  onLayoutChangeRef.current = onLayoutChange;

  useLayoutEffect(() => {
    onLayoutChangeRef.current?.();
  }, [entry?.definition, entry?.status, entry?.refCount, entry?.origin]);

  if (!entry) return null;
  const waiting = entry.status === "pending" || (entry.status === "streaming" && !entry.definition);

  return (
    <div className="glossary-card" onMouseDown={(event) => event.stopPropagation()}>
      <div className="glossary-card-header">
        <BookA width={15} height={15} className="glossary-card-icon" />
        <span className="glossary-card-term">{entry.term}</span>
        <OriginBadge origin={entry.origin} term={entry.term} />
      </div>

      {entry.status === "error" ? (
        <div className="glossary-card-error">
          <span>{entry.error}</span>
          <button type="button" className="glossary-card-link" onClick={() => onRetry(entry.id)}>
            <RotateCw width={12} height={12} /> Retry
          </button>
        </div>
      ) : waiting ? (
        <p className="glossary-card-status">
          <span className="glossary-spinner" aria-hidden="true" />
          {lookupStatusText(entry)}
        </p>
      ) : (
        <GlossaryMeaning entry={entry} pageLabel={pageLabel} onJumpToRef={onJumpToRef} />
      )}

      <div className="glossary-card-footer">
        <span className="glossary-card-saved">
          <Check width={12} height={12} strokeWidth={2.5} /> Saved to glossary
          {entry.refCount > 0 ? ` · ${refCountText(entry.refCount)}` : ""}
        </span>
        <button type="button" className="glossary-card-link" onClick={() => onOpenInGlossary(entry.id)}>
          Open <ChevronRight width={12} height={12} />
        </button>
      </div>
    </div>
  );
}
