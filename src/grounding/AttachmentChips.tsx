import { FileText, MessageSquareQuote, X } from "lucide-react";
import { attachmentLabel, type Attachment } from "./attachments";

// What the reader added to a question: above the composer (removable) and
// with the question once asked. Document text carries its page; a page
// region shows a thumbnail; text from an answer is marked as such, since
// it's context rather than a citable source.
export default function AttachmentChips({
  attachments,
  pageLabel,
  onRemove,
}: {
  attachments: Attachment[];
  pageLabel: (pageNumber: number) => string;
  onRemove?: (id: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul className="attachment-chips">
      {attachments.map((attachment) => (
        <li
          key={attachment.id}
          className={`attachment-chip attachment-chip--${attachment.kind}`}
          title={
            attachment.kind === "region"
              ? `A region of the page, sent as an image${attachment.text ? ` (its text: ${attachment.text})` : ""}`
              : `${attachment.text}${attachment.truncated ? "\n\n(Shortened — only the start is sent.)" : ""}`
          }
        >
          {attachment.kind === "region" && attachment.image ? (
            <img
              className="attachment-chip-thumb"
              src={`data:${attachment.image.mediaType};base64,${attachment.image.data}`}
              alt=""
            />
          ) : attachment.kind === "document" ? (
            <FileText width={12} height={12} aria-hidden="true" />
          ) : (
            <MessageSquareQuote width={12} height={12} aria-hidden="true" />
          )}
          <span className="attachment-chip-text">{attachmentLabel(attachment, pageLabel)}</span>
          {onRemove ? (
            <button type="button" className="attachment-chip-remove" onClick={() => onRemove(attachment.id)} title="Remove">
              <X width={11} height={11} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
