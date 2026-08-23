import { useLayoutEffect, useRef, useState } from "react";
import CommentForm from "./CommentForm";
import DiveActionButtons from "../deepdive/DiveActionButtons";
import type { GhostHighlight } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";

interface ExpandableTipProps {
  addHighlight: (highlight: GhostHighlight, comment: string) => void;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onPin: (selectionText: string, pageNumber: number) => void;
}

export default function ExpandableTip({
  addHighlight,
  onDiveDeeper,
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

  // Pin needs a text phrase to explain — an area selection's content is an
  // image, not text, so it's hidden for it. Highlight and Dive deeper work
  // for either: text goes straight to the model, an area selection sends its
  // screenshot instead.
  const currentSelection = getCurrentSelection();
  const hasTextSelection = Boolean(currentSelection?.content.text);

  return (
    <div className="expandable-tip">
      {compact ? (
        <DiveActionButtons
          onHighlight={() => {
            setCompact(false);
            selectionRef.current = getCurrentSelection();
            selectionRef.current?.makeGhostHighlight();
          }}
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
          onPin={
            hasTextSelection
              ? () => {
                  const selection = getCurrentSelection();
                  const text = selection?.content.text;
                  if (!text) return;
                  onPin(text, selection.position.boundingRect.pageNumber);
                }
              : undefined
          }
        />
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
