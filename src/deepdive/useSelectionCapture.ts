import { useEffect, useState, type RefObject } from "react";
import type { AnchorRect } from "./useFlippedPlacement";
import { selectionOccurrence, serializeElement, serializeRange } from "./selectionText";

export interface CapturedSelection {
  text: string;
  context: string;
  anchorRect: AnchorRect;
  // Where the selection sits — the turn (see data-turn-index on each turn's
  // markdown) and which copy of `text` within it — so a highlight made from
  // it is placed back on exactly this spot. Unset if it wasn't in a turn.
  turnIndex?: number;
  occurrence?: number;
}

const MAX_SELECTION_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 1000;

// Mirrors LearningApp's selection-popover trigger: mouseup inside the given
// container, deferred so window.getSelection() reflects the final selection.
// anchorRect is viewport-relative (not scroll-adjusted) since the popover
// that consumes this renders position: fixed — see useFlippedPlacement,
// which turns it into an above/below-flipped position for that popover.
export function useSelectionCapture(
  containerRef: RefObject<HTMLElement | null>,
  contextSelector: string,
) {
  const [captured, setCaptured] = useState<CapturedSelection | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !selection.toString().trim()) return;
        // Not selection.toString(): see serializeRange for why that mangles
        // any rendered equation the selection touches.
        const range = selection.getRangeAt(0);
        const text = serializeRange(range);
        if (!text || text.length > MAX_SELECTION_LENGTH) return;
        const anchorNode = selection.anchorNode;
        const anchorElement =
          anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
        const contextElement = anchorElement?.closest(contextSelector);
        const context = contextElement ? serializeElement(contextElement).slice(0, MAX_CONTEXT_LENGTH) : "";
        const turnElement = anchorElement?.closest<HTMLElement>("[data-turn-index]");
        const placement = turnElement
          ? {
              turnIndex: Number(turnElement.dataset.turnIndex),
              occurrence: selectionOccurrence(turnElement, range, text),
            }
          : {};
        const rect = range.getBoundingClientRect();
        setCaptured({
          text,
          context,
          anchorRect: { left: rect.left, top: rect.top, bottom: rect.bottom },
          ...placement,
        });
      }, 0);
    };

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [containerRef, contextSelector]);

  return { captured, clear: () => setCaptured(null) };
}
