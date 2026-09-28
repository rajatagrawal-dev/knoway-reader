import { useEffect, useRef } from "react";
import { HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import type { DiveHighlight } from "./types";
import { useNoteControl } from "../components/NoteControl";
import HighlightToolbar from "../components/HighlightToolbar";
import { useFlippedPlacement, type AnchorRect } from "./useFlippedPlacement";

type HighlightEdit = Partial<Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "comment">>;

export interface DiveHighlightEditTipProps {
  highlight: DiveHighlight;
  anchorRect: AnchorRect;
  onEdit: (edit: HighlightEdit) => void;
  onDelete: () => void;
  onOpenDive: (divePanelId: string) => void;
  onStartDive: () => void;
  onClose: () => void;
}

// The dive-panel equivalent of the main PDF highlight's edit toolbar (see
// HighlightContainer.tsx, which composes the library's own patched
// TextHighlight toolbar): opened by clicking an existing highlight rather
// than by making a fresh selection (that's DiveSelectionTip), so it edits
// in place — color/style pick without closing the tip, matching the
// library's own behavior — and adds a delete button that DiveSelectionTip
// has no use for. Positioned the same flipped-above/below way as
// DiveSelectionTip (see useFlippedPlacement) so it never covers the
// highlight it's editing.
export default function DiveHighlightEditTip({
  highlight,
  anchorRect,
  onEdit,
  onDelete,
  onOpenDive,
  onStartDive,
  onClose,
}: DiveHighlightEditTipProps) {
  const tipRef = useRef<HTMLDivElement>(null);

  const commentControls = useNoteControl({
    comment: highlight.comment,
    onCommit: (comment) => onEdit({ comment }),
    classPrefix: "TextHighlight",
    containerRef: tipRef,
  });

  const placement = useFlippedPlacement(tipRef, anchorRect, [commentControls.showComment]);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (tipRef.current && !tipRef.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="dive-selection-tip" style={{ left: placement.left, top: placement.top }} ref={tipRef}>
      <HighlightToolbar
        copyText={highlight.text}
        note={commentControls}
        divePanelId={highlight.divePanelId}
        onOpenDive={onOpenDive}
        onStartDive={onStartDive}
        onDelete={onDelete}
        activeStyle={highlight.highlightStyle ?? "highlight"}
        onStyleChange={(highlightStyle) => onEdit({ highlightStyle })}
        activeColor={highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0]}
        onColorChange={(highlightColor) => onEdit({ highlightColor })}
      />
    </div>
  );
}
