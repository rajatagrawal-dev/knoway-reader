import { useEffect, useState, type RefObject } from "react";

export interface CapturedSelection {
  text: string;
  context: string;
  position: { x: number; y: number };
}

const MAX_SELECTION_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 1000;

// Mirrors LearningApp's selection-popover trigger: mouseup inside the given
// container, deferred so window.getSelection() reflects the final selection.
// Position is viewport-relative (not scroll-adjusted) since the popover that
// consumes this renders position: fixed.
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
        const text = selection ? selection.toString().trim() : "";
        if (!text || text.length > MAX_SELECTION_LENGTH || !selection || selection.rangeCount === 0) {
          return;
        }
        const anchorNode = selection.anchorNode;
        const anchorElement =
          anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
        const context =
          anchorElement?.closest(contextSelector)?.textContent?.slice(0, MAX_CONTEXT_LENGTH) || "";
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setCaptured({
          text,
          context,
          position: { x: rect.left, y: rect.bottom + 6 },
        });
      }, 0);
    };

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [containerRef, contextSelector]);

  return { captured, clear: () => setCaptured(null) };
}
