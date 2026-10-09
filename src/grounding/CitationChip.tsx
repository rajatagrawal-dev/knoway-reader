import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFlippedPlacement, type AnchorRect } from "../deepdive/useFlippedPlacement";
import type { ChipTarget } from "./citations";
import type { SourceRef } from "./types";

const SHOW_DELAY_MS = 200;
const HIDE_DELAY_MS = 200;
const CARD_WIDTH = 360;
const VIEWPORT_MARGIN = 8;

export interface ResolvedRef {
  source: SourceRef;
  range: [number, number]; // page-text offsets of the sentence the claim rests on
}

export interface CitationChipProps {
  kind: ChipTarget["kind"];
  quoteMissing: boolean;
  label: string; // "p. 42", "general", …
  refs: ResolvedRef[];
  pageLabel: (pageNumber: number) => string;
  onJump: (ref: ResolvedRef) => void;
}

const KIND_NOTES: Record<ChipTarget["kind"], string> = {
  stated: "",
  inferred: "Reasoned from this passage rather than stated in it.",
  general: "From general knowledge, not from this document.",
  unverified: "Cites a passage that wasn't provided, so it couldn't be checked.",
};

// A citation after a claim: hover to read the passage it rests on, click to
// see it in the PDF. The chip has no text of its own — its label is drawn
// by CSS from data-label — because dive selections and highlights count
// characters in the rendered answer, and a chip's text would shift them.
export default function CitationChip({ kind, quoteMissing, label, refs, pageLabel, onJump }: CitationChipProps) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const chipRef = useRef<HTMLAnchorElement>(null);

  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (rect) setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom });
    }, SHOW_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAnchor(null), HIDE_DELAY_MS);
  };

  const description = [label, KIND_NOTES[kind], quoteMissing ? "The quoted words weren't found in the passage." : ""]
    .filter(Boolean)
    .join(". ");

  return (
    <>
      <a
        ref={chipRef}
        href="#"
        className={`cite-chip cite-chip--${kind}${quoteMissing ? " cite-chip--warn" : ""}`}
        data-label={label}
        aria-label={`Source: ${description}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (refs[0]) onJump(refs[0]);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      />
      {anchor
        ? createPortal(
            <CitationPreview
              anchor={anchor}
              kind={kind}
              quoteMissing={quoteMissing}
              refs={refs}
              pageLabel={pageLabel}
              onJump={(ref) => {
                setAnchor(null);
                onJump(ref);
              }}
              onPointerEnter={() => window.clearTimeout(timer.current)}
              onPointerLeave={hide}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function CitationPreview({
  anchor,
  kind,
  quoteMissing,
  refs,
  pageLabel,
  onJump,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: AnchorRect;
  kind: ChipTarget["kind"];
  quoteMissing: boolean;
  refs: ResolvedRef[];
  pageLabel: (pageNumber: number) => string;
  onJump: (ref: ResolvedRef) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clamped = {
    ...anchor,
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchor.left - 24, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)),
  };
  const placement = useFlippedPlacement(ref, clamped, [refs.length]);
  const note = [KIND_NOTES[kind], quoteMissing ? "The quoted words weren't found in this passage." : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={ref}
      className="cite-preview"
      role="tooltip"
      style={{ left: placement.left, top: placement.top, width: CARD_WIDTH }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {note ? <p className="cite-preview-note">{note}</p> : null}
      {refs.map((resolved) => {
        const { source, range } = resolved;
        // The passage, with the sentence the claim rests on set off.
        const from = Math.max(0, range[0] - source.start);
        const to = Math.min(source.text.length, range[1] - source.start);
        return (
          <button
            type="button"
            key={`${source.label}-${range[0]}`}
            className="cite-preview-source"
            onClick={() => onJump(resolved)}
            title="Show in the PDF"
          >
            <span className="cite-preview-page">p. {pageLabel(source.pageNumber)}</span>
            <span className="cite-preview-text">
              {source.text.slice(0, from)}
              <mark>{source.text.slice(from, to)}</mark>
              {source.text.slice(to)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
