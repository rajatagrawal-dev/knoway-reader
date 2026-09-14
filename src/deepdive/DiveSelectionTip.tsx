import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Highlighter, Palette, Strikethrough, Underline } from "lucide-react";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import type { DiveHighlight } from "./types";
import { useNoteControl } from "../components/NoteControl";
import DiveControl from "./DiveControl";

type HighlightStyleOverride = Pick<DiveHighlight, "highlightColor" | "highlightStyle">;
type Menu = "color" | "style" | null;

export interface DiveSelectionTipProps {
  selectionText: string;
  position: { x: number; y: number };
  onAddHighlight: (text: string, comment: string, style?: HighlightStyleOverride) => void;
  onDiveDeeper: () => void;
  onPin: () => void;
  onClose: () => void;
}

// The dive-panel equivalent of ExpandableTip: same toolbar, same color/style
// options, for a plain-text selection inside AI dialogue instead of a PDF
// text selection. Reuses the library's own TextHighlight__* classes (see
// App.css) so it looks identical to the main-text tip, but — having no
// react-pdf-highlighter tip-container to be positioned by — renders itself
// as a fixed-position popover the way the old SelectionPopover did.
export default function DiveSelectionTip({
  selectionText,
  position,
  onAddHighlight,
  onDiveDeeper,
  onPin,
  onClose,
}: DiveSelectionTipProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (tipRef.current && !tipRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [onClose]);

  const finalize = (style: HighlightStyleOverride | undefined, commentText: string) => {
    onAddHighlight(selectionText, commentText, style);
    onClose();
  };

  const commentControls = useNoteControl({
    comment: undefined,
    onCommit: (comment) => {
      if (comment.trim()) finalize(undefined, comment.trim());
    },
    classPrefix: "TextHighlight",
    containerRef: tipRef,
  });

  const handleCopy = async () => {
    await navigator.clipboard.writeText(selectionText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handlePin = () => {
    onPin();
    setPinned(true);
  };

  const toggleMenu = (next: Exclude<Menu, null>) => {
    setMenu((current) => (current === next ? null : next));
  };

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
          <span
            className="TextHighlight__color-trigger-dot"
            style={{ backgroundColor: HIGHLIGHT_COLOR_PRESETS[0] }}
          />
          <ChevronDown width={12} height={12} strokeWidth={2.5} />
        </button>
        <div className="TextHighlight__toolbar-divider" />
        <button
          type="button"
          className="TextHighlight__style-button"
          title="Change style"
          onClick={() => toggleMenu("style")}
        >
          <Palette width={14} height={14} />
        </button>
        <button
          type="button"
          className="TextHighlight__copy-button"
          title={copied ? "Copied" : "Copy text"}
          onClick={handleCopy}
        >
          {copied ? <Check width={14} height={14} strokeWidth={2.5} /> : <Copy width={14} height={14} />}
        </button>
        {commentControls.button}
        <DiveControl onStart={onDiveDeeper} />
        <button type="button" className="dive-badge" onClick={handlePin} disabled={pinned}>
          {pinned ? "Pinned" : "Pin"}
        </button>
      </div>

      {menu === "color" ? (
        <div className="TextHighlight__color-menu" onClick={(event) => event.stopPropagation()}>
          {HIGHLIGHT_COLOR_PRESETS.map((presetColor) => (
            <button
              key={presetColor}
              type="button"
              className="TextHighlight__color-menu-item"
              onClick={() => finalize({ highlightColor: presetColor }, "")}
            >
              <span className="TextHighlight__color-menu-dot" style={{ backgroundColor: presetColor }} />
              <span className="TextHighlight__color-menu-label">
                {HIGHLIGHT_COLOR_NAMES[presetColor] || presetColor}
              </span>
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
                className="TextHighlight__style-type-button"
                title="Highlight"
                onClick={() => finalize({ highlightStyle: "highlight" }, "")}
              >
                <Highlighter width={16} height={16} />
              </button>
              <button
                type="button"
                className="TextHighlight__style-type-button"
                title="Underline"
                onClick={() => finalize({ highlightStyle: "underline" }, "")}
              >
                <Underline width={16} height={16} />
              </button>
              <button
                type="button"
                className="TextHighlight__style-type-button"
                title="Strikethrough"
                onClick={() => finalize({ highlightStyle: "strikethrough" }, "")}
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
