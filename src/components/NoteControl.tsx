import { useEffect, useRef, useState, type RefObject } from "react";

interface NoteControlOptions {
  comment: string | undefined;
  onCommit: (comment: string) => void;
  classPrefix: "TextHighlight" | "AreaHighlight";
  // When provided, a blur only commits if focus is leaving this container
  // entirely. Clicking another control in the same tip (e.g. a color swatch)
  // blurs the textarea before that control's own click fires; for a fresh
  // selection that control is what creates the highlight, so committing here
  // first would create it with no color/style chosen and close the tip out
  // from under the click. Existing highlights don't need this — committing
  // early there just saves the comment, which is harmless.
  containerRef?: RefObject<HTMLElement | null>;
}

export function useNoteControl({ comment, onCommit, classPrefix, containerRef }: NoteControlOptions) {
  const [showComment, setShowComment] = useState(false);
  const [draft, setDraft] = useState(comment || "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxTextareaHeight = 160;

  useEffect(() => {
    if (showComment) setDraft(comment || "");
  }, [showComment, comment]);

  useEffect(() => {
    if (showComment) textareaRef.current?.focus();
  }, [showComment]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element || !showComment) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, maxTextareaHeight)}px`;
  }, [showComment, draft]);

  const hasComment = Boolean(comment);

  const commit = () => onCommit(draft);
  const close = () => setShowComment(false);

  const button = (
    <button
      type="button"
      className={`${classPrefix}__comment-button`}
      title={hasComment ? "Edit comment" : "Add comment"}
      onClick={(event) => {
        event.stopPropagation();
        setShowComment((value) => !value);
      }}
    >
      Note
    </button>
  );

  const panel = showComment ? (
    <div className={`${classPrefix}__comment-panel`} onClick={(event) => event.stopPropagation()}>
      <textarea
        ref={textareaRef}
        className={`${classPrefix}__comment-textarea`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          const next = event.relatedTarget as Node | null;
          if (containerRef?.current && next && containerRef.current.contains(next)) return;
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
            setDraft(comment || "");
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
