import { useLayoutEffect, useRef, useState } from "react";
import CommentForm from "./CommentForm";
import DiveActionButtons from "../deepdive/DiveActionButtons";
import type { GhostHighlight } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";

interface ExpandableTipProps {
  addHighlight: (highlight: GhostHighlight, comment: string) => void;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onQuickMeaning: (selectionText: string, pageNumber: number) => Promise<string>;
  onPin: (selectionText: string, pageNumber: number) => void;
}

export default function ExpandableTip({
  addHighlight,
  onDiveDeeper,
  onQuickMeaning,
  onPin,
}: ExpandableTipProps) {
  const [compact, setCompact] = useState(true);
  const selectionRef = useRef<ReturnType<
    ReturnType<typeof usePdfHighlighterContext>["getCurrentSelection"]
  > | null>(null);

  const {
    getCurrentSelection,
    removeGhostHighlight,
    setTip,
    updateTipPosition,
  } = usePdfHighlighterContext();

  useLayoutEffect(() => {
    updateTipPosition?.();
  }, [compact, updateTipPosition]);

  // Dive deeper / Quick meaning / Pin all need a text phrase to explain —
  // an area selection's content is an image, not text, so these have
  // nothing to act on and are hidden rather than silently doing nothing.
  const hasTextSelection = Boolean(getCurrentSelection()?.content.text);

  return (
    <div className="expandable-tip">
      {compact ? (
        <>
          <button
            type="button"
            className="tip-button"
            onClick={() => {
              setCompact(false);
              selectionRef.current = getCurrentSelection();
              selectionRef.current?.makeGhostHighlight();
            }}
          >
            Add highlight
          </button>
          {hasTextSelection ? (
            <DiveActionButtons
              onDiveDeeper={() => {
                const selection = getCurrentSelection();
                if (!selection) return;
                onDiveDeeper({
                  content: selection.content,
                  type: selection.type,
                  position: selection.position,
                });
                setTip(null);
              }}
              onQuickMeaning={async () => {
                const selection = getCurrentSelection();
                const text = selection?.content.text;
                if (!text) throw new Error("No text selected.");
                return onQuickMeaning(text, selection.position.boundingRect.pageNumber);
              }}
              onPin={() => {
                const selection = getCurrentSelection();
                const text = selection?.content.text;
                if (!text) return;
                onPin(text, selection.position.boundingRect.pageNumber);
              }}
            />
          ) : null}
        </>
      ) : (
        <CommentForm
          onSubmit={(input) => {
            const selection = selectionRef.current;
            if (!selection) return;

            addHighlight(
              {
                content: selection.content,
                type: selection.type,
                position: selection.position,
              },
              input,
            );

            removeGhostHighlight();
            setTip(null);
          }}
        />
      )}
    </div>
  );
}
