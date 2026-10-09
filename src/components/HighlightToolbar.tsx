import { useState, type ReactNode } from "react";
import { Check, Copy, MessageSquarePlus, Trash2 } from "lucide-react";
import DiveControl from "../deepdive/DiveControl";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import { STYLE_BUTTONS, type HighlightStyle } from "../highlightStyles";

export interface HighlightToolbarProps {
  // "AreaHighlight" for image/region highlights: same layout, the library's
  // AreaHighlight__* button classes, and no style buttons (colors only).
  classPrefix?: "TextHighlight" | "AreaHighlight";
  // Shows the copy button when set.
  copyText?: string;
  // From useNoteControl — its toggle button sits in the top row, its panel
  // (when open) replaces both rows (see .highlight-toolbar in App.css).
  // Absent where text can't take a note (an Ask answer).
  note?: { button: ReactNode; panel: ReactNode };
  divePanelId?: string;
  onOpenDive?: (divePanelId: string) => void;
  // Absent where a dive can't start from the text (an Ask answer).
  onStartDive?: () => void;
  // A fresh selection gets Pin; an existing highlight gets Delete.
  onPin?: () => void;
  // Fresh PDF text selections only. When set, `glossaryDisabledReason`
  // (e.g. the selection is a whole passage, not a term) disables it.
  onAddToGlossary?: () => void;
  glossaryDisabledReason?: string;
  // Adds the selection to the next question — Ask's, or the open dive's.
  onAddToQuestion?: () => void;
  addToQuestionTitle?: string;
  onDelete?: () => void;
  // Style buttons are only shown when this is set (text highlights).
  activeStyle?: HighlightStyle;
  onStyleChange?: (style: HighlightStyle) => void;
  // Marks the matching swatch with a check — existing highlights only; a
  // fresh selection has no color yet.
  activeColor?: string;
  // The style + color row is shown only where text can be highlighted.
  onColorChange?: (color: string) => void;
}

// The one highlight tooltip used everywhere — fresh selections and existing
// highlights, in the main PDF text and in dive panels alike: a top row of
// actions (copy, note, dive, pin/delete) and, as a separate pill below it,
// the style + color row. It only lays out its contents; each caller
// positions it (the library's tip container / toolbar group for the PDF,
// a fixed-position wrapper for dive panels) and wires up what the buttons do.
export default function HighlightToolbar({
  classPrefix = "TextHighlight",
  copyText,
  note,
  divePanelId,
  onOpenDive,
  onStartDive,
  onPin,
  onAddToGlossary,
  glossaryDisabledReason,
  onAddToQuestion,
  addToQuestionTitle,
  onDelete,
  activeStyle,
  onStyleChange,
  activeColor,
  onColorChange,
}: HighlightToolbarProps) {
  const [copied, setCopied] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [added, setAdded] = useState(false);

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!copyText) return;
    await navigator.clipboard.writeText(copyText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="highlight-toolbar">
      <div className="highlight-toolbar__row">
        {copyText ? (
          <button
            type="button"
            className={`${classPrefix}__copy-button`}
            title={copied ? "Copied" : "Copy text"}
            onClick={handleCopy}
          >
            {copied ? <Check width={14} height={14} strokeWidth={2.5} /> : <Copy width={14} height={14} />}
          </button>
        ) : null}
        {note?.button}
        {onStartDive ? <DiveControl divePanelId={divePanelId} onOpen={onOpenDive} onStart={onStartDive} /> : null}
        {onPin ? (
          <button
            type="button"
            className="dive-badge"
            disabled={pinned}
            onClick={(event) => {
              event.stopPropagation();
              onPin();
              setPinned(true);
            }}
          >
            {pinned ? "Pinned" : "Pin"}
          </button>
        ) : null}
        {onAddToGlossary ? (
          <button
            type="button"
            className="dive-badge"
            title={glossaryDisabledReason ?? "Add to glossary"}
            disabled={Boolean(glossaryDisabledReason)}
            onClick={(event) => {
              event.stopPropagation();
              onAddToGlossary();
            }}
          >
            Glossary
          </button>
        ) : null}
        {onAddToQuestion ? (
          <button
            type="button"
            className="dive-badge add-to-question"
            title={addToQuestionTitle ?? "Add to your question"}
            disabled={added}
            onClick={(event) => {
              event.stopPropagation();
              onAddToQuestion();
              setAdded(true);
            }}
          >
            {added ? <Check width={12} height={12} strokeWidth={2.5} /> : <MessageSquarePlus width={12} height={12} />}
            {added ? "Added" : "Add to question"}
          </button>
        ) : null}
        {onDelete ? (
          <button
            type="button"
            className={`${classPrefix}__delete-button`}
            title="Delete"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 width={14} height={14} />
          </button>
        ) : null}
      </div>

      {onColorChange ? (
      <div className={`highlight-toolbar__colors ${classPrefix}__color-row`} onClick={(event) => event.stopPropagation()}>
        {onStyleChange ? (
          <>
            {STYLE_BUTTONS.map(({ style, title, icon }) => (
              <button
                key={style}
                type="button"
                className={`TextHighlight__color-row-style ${(activeStyle ?? "highlight") === style ? "active" : ""}`}
                title={title}
                onClick={() => onStyleChange(style)}
              >
                {icon}
              </button>
            ))}
            <div className="TextHighlight__toolbar-divider" />
          </>
        ) : null}
        {HIGHLIGHT_COLOR_PRESETS.map((presetColor) => (
          <button
            key={presetColor}
            type="button"
            className={`${classPrefix}__color-row-item`}
            title={HIGHLIGHT_COLOR_NAMES[presetColor] || presetColor}
            onClick={() => onColorChange(presetColor)}
          >
            <span className={`${classPrefix}__color-row-dot`} style={{ backgroundColor: presetColor }}>
              {activeColor === presetColor ? <Check width={12} height={12} strokeWidth={3} /> : null}
            </span>
          </button>
        ))}
      </div>
      ) : null}

      {note?.panel}
    </div>
  );
}
