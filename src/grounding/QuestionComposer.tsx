import { useEffect, type RefObject } from "react";
import AttachmentChips from "./AttachmentChips";
import type { Attachment } from "./attachments";

// The question box shared by Deep Dive and the Ask panel: what's been added
// to the question (removable chips), then one line — a textarea that grows
// with Shift+Enter lines, and the send button beside it. Enter sends.
export default function QuestionComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  busy = false,
  submitLabel,
  busyLabel,
  attachments,
  pageLabel,
  onRemoveAttachment,
  textareaRef,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean; // nothing can be asked (e.g. no document yet)
  busy?: boolean; // an answer is on its way
  submitLabel: string;
  busyLabel: string;
  attachments: Attachment[];
  pageLabel: (pageNumber: number) => string;
  onRemoveAttachment: (id: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement>;
  className?: string;
}) {
  // One line tall by default, growing with Shift+Enter lines (up to the CSS
  // max-height, then scrolling) and shrinking back once the draft is sent.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight}px`;
  }, [value, textareaRef]);

  return (
    <div className={`question-composer ${className}`}>
      {attachments.length ? (
        <div className="question-composer-attachments">
          <AttachmentChips attachments={attachments} pageLabel={pageLabel} onRemove={onRemoveAttachment} />
        </div>
      ) : null}
      <form
        className="question-composer-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim() && !busy && !disabled) onSubmit();
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || busy}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter adds a line. Not while an IME is
            // composing, where Enter confirms the composed text instead.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <button type="submit" disabled={disabled || busy || !value.trim()}>
          {busy ? busyLabel : submitLabel}
        </button>
      </form>
    </div>
  );
}
