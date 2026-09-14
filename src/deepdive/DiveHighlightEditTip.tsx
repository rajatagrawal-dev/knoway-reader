import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Highlighter, Palette, Strikethrough, Trash2, Underline } from "lucide-react";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import type { DiveHighlight } from "./types";
import { useNoteControl } from "../components/NoteControl";
import DiveControl from "./DiveControl";

type HighlightEdit = Partial<Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "comment">>;
type Menu = "color" | "style" | null;

export interface DiveHighlightEditTipProps {
  highlight: DiveHighlight;
  position: { x: number; y: number };
  onEdit: (edit: HighlightEdit) => void;
  onDelete: () => void;
  onOpenDive: (divePanelId: string) => void;
  onStartDive: () => void;
  onClose: () => void;
}

// The dive-panel equivalent of the main PDF highlight's edit toolbar (see
// HighlightContainer.tsx, which composes the library's own TextHighlight
// toolbar): opened by clicking an existing highlight rather than by making
// a fresh selection (that's DiveSelectionTip), so it edits in place —
// color/style pick without closing the tip, matching the library's own
// behavior — and adds a delete button that DiveSelectionTip has no use for.
export default function DiveHighlightEditTip({
  highlight,
  position,
  onEdit,
  onDelete,
  onOpenDive,
  onStartDive,
  onClose,
}: DiveHighlightEditTipProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const [copied, setCopied] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

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

  const commentControls = useNoteControl({
    comment: highlight.comment,
    onCommit: (comment) => onEdit({ comment }),
    classPrefix: "TextHighlight",
    containerRef: tipRef,
  });

  const handleCopy = async () => {
    await navigator.clipboard.writeText(highlight.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const toggleMenu = (next: Exclude<Menu, null>) => {
    setMenu((current) => (current === next ? null : next));
  };

  const activeColor = highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0];

  return (
    <div className="dive-selection-tip" style={{ left: position.x, top: position.y }} ref={tipRef}>
      <div className="expandable-tip__toolbar">
        <button
          type="button"
          className="TextHighlight__color-trigger"
          aria-label="Highlight color"
          aria-expanded={menu === "color"}
          title="Highlight color"
          onClick={() => toggleMenu("color")}
        >
          <span className="TextHighlight__color-trigger-dot" style={{ backgroundColor: activeColor }} />
          <ChevronDown width={12} height={12} strokeWidth={2.5} />
        </button>
        <div className="TextHighlight__toolbar-divider" />
        <button type="button" className="TextHighlight__style-button" title="Change style" onClick={() => toggleMenu("style")}>
          <Palette width={14} height={14} />
        </button>
        <button type="button" className="TextHighlight__copy-button" title={copied ? "Copied" : "Copy text"} onClick={handleCopy}>
          {copied ? <Check width={14} height={14} strokeWidth={2.5} /> : <Copy width={14} height={14} />}
        </button>
        {commentControls.button}
        <DiveControl divePanelId={highlight.divePanelId} onOpen={onOpenDive} onStart={onStartDive} />
        <button type="button" className="TextHighlight__delete-button" title="Delete" onClick={onDelete}>
          <Trash2 width={14} height={14} />
        </button>
      </div>

      {menu === "color" ? (
        <div className="TextHighlight__color-menu" onClick={(event) => event.stopPropagation()}>
          {HIGHLIGHT_COLOR_PRESETS.map((presetColor) => (
            <button
              key={presetColor}
              type="button"
              className="TextHighlight__color-menu-item"
              onClick={() => {
                onEdit({ highlightColor: presetColor });
                setMenu(null);
              }}
            >
              <span className="TextHighlight__color-menu-dot" style={{ backgroundColor: presetColor }} />
              <span className="TextHighlight__color-menu-label">{HIGHLIGHT_COLOR_NAMES[presetColor] || presetColor}</span>
              {activeColor === presetColor ? (
                <span className="TextHighlight__color-menu-check">
                  <Check width={14} height={14} strokeWidth={2.5} />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {menu === "style" ? (
        <div className="TextHighlight__style-panel" onClick={(event) => event.stopPropagation()}>
          <div className="TextHighlight__style-row">
            <label>Style</label>
            <div className="TextHighlight__style-buttons">
              <button
                type="button"
                className={`TextHighlight__style-type-button ${(highlight.highlightStyle ?? "highlight") === "highlight" ? "active" : ""}`}
                title="Highlight"
                onClick={() => onEdit({ highlightStyle: "highlight" })}
              >
                <Highlighter width={16} height={16} />
              </button>
              <button
                type="button"
                className={`TextHighlight__style-type-button ${highlight.highlightStyle === "underline" ? "active" : ""}`}
                title="Underline"
                onClick={() => onEdit({ highlightStyle: "underline" })}
              >
                <Underline width={16} height={16} />
              </button>
              <button
                type="button"
                className={`TextHighlight__style-type-button ${highlight.highlightStyle === "strikethrough" ? "active" : ""}`}
                title="Strikethrough"
                onClick={() => onEdit({ highlightStyle: "strikethrough" })}
              >
                <Strikethrough width={16} height={16} />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {commentControls.panel}
    </div>
  );
}
