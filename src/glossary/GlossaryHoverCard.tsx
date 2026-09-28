import { useRef } from "react";
import { BookA, ChevronRight } from "lucide-react";
import { useFlippedPlacement, type AnchorRect } from "../deepdive/useFlippedPlacement";
import { DefinitionText, SourceBadge } from "./GlossaryParts";
import { lookupStatusText, refCountText } from "./format";
import { termKey } from "./textIndex";
import type { GlossaryEntry } from "./types";

const CARD_WIDTH = 340;
const VIEWPORT_MARGIN = 8;

interface GlossaryHoverCardProps {
  entry: GlossaryEntry;
  matchedText: string; // the word(s) hovered — may be a related form of the term
  anchorRect: AnchorRect;
  onOpenInGlossary: (entryId: string) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

// A glossary term's definition, shown while hovering one of its marked
// occurrences in the PDF (see GlossaryMarks).
export default function GlossaryHoverCard({
  entry,
  matchedText,
  anchorRect,
  onOpenInGlossary,
  onPointerEnter,
  onPointerLeave,
}: GlossaryHoverCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = {
    ...anchorRect,
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.left, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)),
  };
  const placement = useFlippedPlacement(ref, anchor, [entry.definition, entry.status]);
  const waiting = entry.status === "pending" || (entry.status === "streaming" && !entry.definition);
  // "entangled" marked for the entry "entanglement": say which term it is.
  const isOtherForm = termKey(matchedText) !== entry.key;

  return (
    <div
      ref={ref}
      className="glossary-card glossary-hover-card"
      style={{ left: placement.left, top: placement.top }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      role="tooltip"
    >
      <div className="glossary-card-header">
        <BookA width={15} height={15} className="glossary-card-icon" />
        <span className="glossary-card-term">{entry.term}</span>
        <SourceBadge source={entry.source} />
      </div>
      {isOtherForm ? <p className="glossary-hover-form">Related form: “{matchedText}”</p> : null}

      {entry.status === "error" ? (
        <p className="glossary-card-error">{entry.error}</p>
      ) : waiting ? (
        <p className="glossary-card-status">
          <span className="glossary-spinner" aria-hidden="true" />
          {lookupStatusText(entry)}
        </p>
      ) : (
        <DefinitionText text={entry.definition} streaming={entry.status === "streaming"} />
      )}

      <div className="glossary-card-footer">
        <span>{entry.refCount > 0 ? refCountText(entry.refCount) : ""}</span>
        <button type="button" className="glossary-card-link" onClick={() => onOpenInGlossary(entry.id)}>
          Open in glossary <ChevronRight width={12} height={12} />
        </button>
      </div>
    </div>
  );
}
