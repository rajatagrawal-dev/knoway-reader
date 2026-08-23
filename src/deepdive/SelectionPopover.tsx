import { useEffect, useRef } from "react";
import DiveActionButtons from "./DiveActionButtons";

export interface SelectionPopoverProps {
  selection: string;
  position: { x: number; y: number };
  onDiveDeeper: () => void;
  onPin: () => void;
  onClose: () => void;
}

export default function SelectionPopover({
  selection,
  position,
  onDiveDeeper,
  onPin,
  onClose,
}: SelectionPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="selection-popover"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" className="selection-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <DiveActionButtons onDiveDeeper={onDiveDeeper} onPin={onPin} />
      <p className="selection-popover-selection">"{selection}"</p>
    </div>
  );
}
