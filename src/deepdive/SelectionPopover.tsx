import DiveActionButtons from "./DiveActionButtons";

export interface SelectionPopoverProps {
  selection: string;
  position: { x: number; y: number };
  onDiveDeeper: () => void;
  onQuickMeaning: () => Promise<string>;
  onPin: () => void;
  onClose: () => void;
}

export default function SelectionPopover({
  selection,
  position,
  onDiveDeeper,
  onQuickMeaning,
  onPin,
  onClose,
}: SelectionPopoverProps) {
  return (
    <div
      className="selection-popover"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" className="selection-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <DiveActionButtons onDiveDeeper={onDiveDeeper} onQuickMeaning={onQuickMeaning} onPin={onPin} />
      <p className="selection-popover-selection">"{selection}"</p>
    </div>
  );
}
