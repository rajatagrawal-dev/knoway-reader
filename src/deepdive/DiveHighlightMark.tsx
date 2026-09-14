import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DiveHighlight } from "./types";
import { HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";

function highlightMarkStyle(highlight: DiveHighlight): CSSProperties {
  const color = highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0];
  if (highlight.highlightStyle === "underline") {
    return { background: "transparent", textDecoration: "underline", textDecorationColor: color, textDecorationThickness: "2px" };
  }
  if (highlight.highlightStyle === "strikethrough") {
    return { background: "transparent", textDecoration: "line-through", textDecorationColor: color, textDecorationThickness: "2px" };
  }
  return { backgroundColor: color };
}

export interface DiveHighlightMarkProps {
  highlight: DiveHighlight;
  isScrolledTo: boolean;
  isEditing: boolean;
  onClick: (highlight: DiveHighlight, anchorRect: DOMRect) => void;
  children: ReactNode;
}

// A highlight placed on AI dialogue text. Mirrors the main PDF text
// highlight's two hover/click behaviors (see HighlightContainer.tsx and the
// library's own TextHighlight): hovering (while not being edited) shows the
// comment in the same styled .highlight-comment-tooltip used by the PDF
// highlights — not a native `title` tooltip, which renders as an unstyled
// black OS tooltip and doesn't match the app's look — and clicking opens
// the edit toolbar (DiveHighlightEditTip, rendered by the caller).
export default function DiveHighlightMark({ highlight, isScrolledTo, isEditing, onClick, children }: DiveHighlightMarkProps) {
  const [hovered, setHovered] = useState(false);
  const markRef = useRef<HTMLElement>(null);
  const showCommentTooltip = hovered && !isEditing && Boolean(highlight.comment);

  return (
    <mark
      ref={markRef}
      className={`dive-turn-highlight${isScrolledTo ? " dive-turn-highlight--scrolledTo" : ""}${isEditing ? " dive-turn-highlight--editing" : ""}`}
      style={highlightMarkStyle(highlight)}
      data-dive-highlight-id={highlight.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(event) => {
        event.stopPropagation();
        if (markRef.current) onClick(highlight, markRef.current.getBoundingClientRect());
      }}
    >
      {children}
      {showCommentTooltip ? <span className="highlight-comment-tooltip dive-turn-highlight-tooltip">{highlight.comment}</span> : null}
    </mark>
  );
}
