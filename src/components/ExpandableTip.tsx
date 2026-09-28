import { useLayoutEffect, useRef, useState } from "react";
import type { GhostHighlight } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import { useNoteControl } from "./NoteControl";
import HighlightToolbar from "./HighlightToolbar";
import GlossaryCard from "../glossary/GlossaryCard";
import type { GlossaryStore } from "../glossary/store";
import { isGlossaryCandidate, MAX_TERM_WORDS } from "../glossary/textIndex";

type HighlightStyleOverride = Pick<CommentedHighlight, "highlightColor" | "highlightStyle">;
type HighlightStyle = NonNullable<CommentedHighlight["highlightStyle"]>;

export interface GlossaryTipBindings {
  store: GlossaryStore;
  // Adds the term (or finds it already there) and starts its lookup;
  // returns the entry's id, or null if the selection isn't a usable term.
  onAdd: (selection: string, pageNumber: number) => string | null;
  onOpenInGlossary: (entryId: string) => void;
  onRetry: (entryId: string) => void;
}

interface ExpandableTipProps {
  addHighlight: (
    highlight: GhostHighlight,
    comment: string,
    style?: HighlightStyleOverride,
  ) => void;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onPin: (selectionText: string, pageNumber: number) => void;
  glossary: GlossaryTipBindings;
}

export default function ExpandableTip({
  addHighlight,
  onDiveDeeper,
  onPin,
  glossary,
}: ExpandableTipProps) {
  const [pendingStyle, setPendingStyle] = useState<HighlightStyle>("highlight");
  // Set once "Glossary" is clicked: the tip then shows that entry's
  // definition card in place of the toolbar.
  const [glossaryEntryId, setGlossaryEntryId] = useState<string | null>(null);
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
      if (comment.trim())
        finalize(hasTextSelection ? { highlightStyle: pendingStyle } : undefined, comment.trim());
    },
    classPrefix: hasTextSelection ? "TextHighlight" : "AreaHighlight",
    containerRef: tipRef,
  });

  useLayoutEffect(() => {
    updateTipPosition?.();
  }, [commentControls.showComment, updateTipPosition]);

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
  };

  const handleAddToGlossary = () => {
    const selection = getCurrentSelection();
    const text = selection?.content.text;
    if (!text) return;
    const entryId = glossary.onAdd(text, selection.position.boundingRect.pageNumber);
    if (entryId) setGlossaryEntryId(entryId);
  };

  if (glossaryEntryId) {
    return (
      <div className="expandable-tip" ref={tipRef}>
        <GlossaryCard
          store={glossary.store}
          entryId={glossaryEntryId}
          onOpenInGlossary={(entryId) => {
            glossary.onOpenInGlossary(entryId);
            setTip(null);
          }}
          onRetry={glossary.onRetry}
          onLayoutChange={updateTipPosition}
        />
      </div>
    );
  }

  const selectionText = currentSelection?.content.text ?? "";

  return (
    <div className="expandable-tip" ref={tipRef}>
      <HighlightToolbar
        classPrefix={hasTextSelection ? "TextHighlight" : "AreaHighlight"}
        copyText={currentSelection?.content.text || undefined}
        note={commentControls}
        onStartDive={handleDive}
        onPin={hasTextSelection ? handlePin : undefined}
        onAddToGlossary={hasTextSelection ? handleAddToGlossary : undefined}
        glossaryDisabledReason={
          isGlossaryCandidate(selectionText) ? undefined : `Select a single term (up to ${MAX_TERM_WORDS} words)`
        }
        activeStyle={pendingStyle}
        onStyleChange={hasTextSelection ? setPendingStyle : undefined}
        onColorChange={(presetColor) =>
          finalize(
            hasTextSelection
              ? { highlightColor: presetColor, highlightStyle: pendingStyle }
              : { highlightColor: presetColor },
            "",
          )
        }
      />
    </div>
  );
}
