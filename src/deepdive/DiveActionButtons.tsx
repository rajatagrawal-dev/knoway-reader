import { useState } from "react";

export interface DiveActionButtonsProps {
  // Only the main PDF selection toolbar can turn a selection into a
  // highlight; the dive-panel selection popover has no highlight concept, so
  // that caller omits this and the button doesn't show.
  onHighlight?: () => void;
  onDiveDeeper: () => void;
  // Pin needs a text phrase to act on; an area/image selection has none, so
  // callers omit this and only "Highlight"/"Dive deeper" show.
  onPin?: () => void;
}

export default function DiveActionButtons({
  onHighlight,
  onDiveDeeper,
  onPin,
}: DiveActionButtonsProps) {
  const [pinned, setPinned] = useState(false);

  const handlePin = () => {
    onPin?.();
    setPinned(true);
  };

  return (
    <div className="dive-action-buttons">
      <div className="dive-action-row">
        {onHighlight ? (
          <button type="button" onClick={onHighlight}>
            Highlight
          </button>
        ) : null}
        <button type="button" onClick={onDiveDeeper}>
          Dive deeper
        </button>
        {onPin ? (
          <button type="button" onClick={handlePin} disabled={pinned}>
            {pinned ? "Pinned" : "Pin"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
