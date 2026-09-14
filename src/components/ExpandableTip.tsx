import { useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Highlighter, Palette, Strikethrough, Underline } from "lucide-react";
import type { GhostHighlight } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import { useNoteControl } from "./NoteControl";
import DiveControl from "../deepdive/DiveControl";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";

type HighlightStyleOverride = Pick<CommentedHighlight, "highlightColor" | "highlightStyle">;
type Menu = "color" | "style" | null;

interface ExpandableTipProps {
  addHighlight: (
    highlight: GhostHighlight,
    comment: string,
    style?: HighlightStyleOverride,
  ) => void;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onPin: (selectionText: string, pageNumber: number) => void;
}

export default function ExpandableTip({
  addHighlight,
  onDiveDeeper,
  onPin,
}: ExpandableTipProps) {
  const [menu, setMenu] = useState<Menu>(null);
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  const { getCurrentSelection, setTip, updateTipPosition, removeGhostHighlight } =
    usePdfHighlighterContext();

  const currentSelection = getCurrentSelection();
  const hasTextSelection = Boolean(currentSelection?.content.text);

  const finalize = (style: HighlightStyleOverride | undefined, commentText: string) => {
    const selection = getCurrentSelection();
    if (!selection) return;
    // makeGhostHighlight() (rather than reading selection.content/type/position
    // directly) is what tells the highlighter to clear its underlying mouse/text
    // selection overlay — skipping it left the dashed area-selection box (or the
    // native text selection) stuck on the page after the highlight was created.
    // removeGhostHighlight() then clears the resulting ghost/editing state now
    // that addHighlight has turned it into a real, persisted highlight — without
    // it the highlighter still considers itself "editing," which (among other
    // things) suppresses hover tooltips on every highlight.
    addHighlight(selection.makeGhostHighlight(), commentText, style);
    removeGhostHighlight();
    setTip(null);
  };

  const commentControls = useNoteControl({
    comment: undefined,
    onCommit: (comment) => {
      if (comment.trim()) finalize(undefined, comment.trim());
    },
    classPrefix: hasTextSelection ? "TextHighlight" : "AreaHighlight",
    containerRef: tipRef,
  });

  useLayoutEffect(() => {
    updateTipPosition?.();
  }, [menu, commentControls.showComment, updateTipPosition]);

  const handleCopy = async () => {
    const text = getCurrentSelection()?.content.text;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleDive = () => {
    const selection = getCurrentSelection();
    if (!selection) return;
    onDiveDeeper(selection.makeGhostHighlight());
    removeGhostHighlight();
    setTip(null);
  };

  const handlePin = () => {
    const selection = getCurrentSelection();
    const text = selection?.content.text;
    if (!text) return;
    onPin(text, selection.position.boundingRect.pageNumber);
    setPinned(true);
  };

  const toggleMenu = (next: Exclude<Menu, null>) => {
    setMenu((current) => (current === next ? null : next));
  };

  return (
    <div className="expandable-tip" ref={tipRef}>
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
        {hasTextSelection ? (
          <button
            type="button"
            className="TextHighlight__style-button"
            title="Change style"
            onClick={() => toggleMenu("style")}
          >
            <Palette width={14} height={14} />
          </button>
        ) : null}
        {hasTextSelection ? (
          <button
            type="button"
            className="TextHighlight__copy-button"
            title={copied ? "Copied" : "Copy text"}
            onClick={handleCopy}
          >
            {copied ? <Check width={14} height={14} strokeWidth={2.5} /> : <Copy width={14} height={14} />}
          </button>
        ) : null}
        {commentControls.button}
        <DiveControl onStart={handleDive} />
        {hasTextSelection ? (
          <button type="button" className="dive-badge" onClick={handlePin} disabled={pinned}>
            {pinned ? "Pinned" : "Pin"}
          </button>
        ) : null}
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
