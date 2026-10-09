import { useEffect, useRef, type ReactNode } from "react";
import { useFlippedPlacement, type AnchorRect } from "../deepdive/useFlippedPlacement";

// A selection toolbar for text outside the PDF (dive and Ask answers):
// fixed-position, flipped above/below the selection so it never covers it
// (see useFlippedPlacement), and closed by a click anywhere else.
export default function FloatingTip({
  anchorRect,
  onClose,
  deps = [],
  children,
}: {
  anchorRect: AnchorRect;
  onClose: () => void;
  deps?: unknown[]; // anything that changes the tip's height while open
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useFlippedPlacement(ref, anchorRect, deps);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  return (
    <div className="dive-selection-tip" style={{ left: placement.left, top: placement.top }} ref={ref}>
      {children}
    </div>
  );
}
