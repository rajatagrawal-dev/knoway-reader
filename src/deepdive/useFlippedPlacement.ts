import { useLayoutEffect, useState, type RefObject } from "react";

export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

const GAP = 6;

// Positions a position:fixed popover so it never covers the anchor it was
// opened from — floating above it by default, flipping below when there
// isn't room above the viewport's top edge. Mirrors the approach the
// underlying PDF highlighter's own TipContainer uses for the main-text
// tips: there's no way to know a popover's rendered height before it's in
// the DOM, so this renders once with a same-side guess, measures the real
// height via the caller's ref (the caller owns it — often because it also
// hands the same ref to something else, e.g. an outside-click detector or
// useNoteControl's containerRef — so it can't be created inside this hook),
// and corrects the position in useLayoutEffect — which runs (and
// re-renders) before the browser paints, so the correction never flashes.
// `deps` should list anything that changes the popover's own rendered
// height while it stays open (e.g. a comment panel toggling), so the
// position is recomputed and the box keeps growing away from the anchor
// rather than over it.
export function useFlippedPlacement(
  ref: RefObject<HTMLElement | null>,
  anchorRect: AnchorRect,
  deps: unknown[] = [],
) {
  const [placement, setPlacement] = useState(() => ({
    left: anchorRect.left,
    top: anchorRect.bottom + GAP,
  }));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const height = el.offsetHeight;
    const below = anchorRect.top - GAP - height < 0;
    setPlacement({
      left: anchorRect.left,
      top: below ? anchorRect.bottom + GAP : anchorRect.top - GAP - height,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, anchorRect.left, anchorRect.top, anchorRect.bottom, ...deps]);

  return placement;
}
