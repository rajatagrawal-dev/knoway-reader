import { useEffect, useRef, useState } from "react";
import type { ViewportHighlight } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";

export function useHighlightCommentControls(
  highlight: ViewportHighlight<CommentedHighlight>,
  onEdit: ((edit: Partial<CommentedHighlight>) => void) | undefined,
  classPrefix: "TextHighlight" | "AreaHighlight",
) {
  const [showComment, setShowComment] = useState(false);
  const [draft, setDraft] = useState(highlight.comment || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxTextareaHeight = 160;

  useEffect(() => {
    if (showComment) setDraft(highlight.comment || "");
  }, [showComment, highlight.comment]);

  useEffect(() => {
    if (showComment) textareaRef.current?.focus();
  }, [showComment]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !showComment) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxTextareaHeight)}px`;
  }, [showComment, draft]);

  const hasComment = Boolean(highlight.comment);

  const commit = () => onEdit?.({ comment: draft });
  const close = () => setShowComment(false);

  const button = onEdit ? (
    <button
      type="button"
      className={`${classPrefix}__comment-button`}
      title={hasComment ? "Edit comment" : "Add comment"}
      onClick={(event) => {
        event.stopPropagation();
        setShowComment((value) => !value);
      }}
    >
      {hasComment ? "Note" : "Comment"}
    </button>
  ) : null;

  const panel =
    onEdit && showComment ? (
      <div
        className={`${classPrefix}__comment-panel`}
        onClick={(event) => event.stopPropagation()}
      >
        <textarea
          ref={textareaRef}
          className={`${classPrefix}__comment-textarea`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            commit();
            close();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              commit();
              close();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(highlight.comment || "");
              close();
            }
          }}
          rows={2}
          placeholder="Add a note…"
        />
      </div>
    ) : null;

  return { button, panel, showComment };
}
