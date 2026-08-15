import type { CommentedHighlight } from "../types";
import type { Pin } from "../deepdive/types";
import DiveBadge from "../deepdive/DiveBadge";

interface SidebarProps {
  highlights: CommentedHighlight[];
  pins: Pin[];
  fileName: string;
  scrolledToHighlightId: string | null;
  onJumpToHighlight: (highlight: CommentedHighlight) => void;
  onDeleteHighlight: (highlight: CommentedHighlight) => void;
  onClearHighlights: () => void;
  onOpenDive: (divePanelId: string) => void;
  onDeletePin: (pinId: string) => void;
  onUploadNew: () => void;
}

function highlightLabel(highlight: CommentedHighlight): string {
  if (highlight.content?.text) return highlight.content.text;
  if (highlight.type === "freetext") return "Sticky note";
  if (highlight.type === "area") return "Area highlight";
  return "Highlight";
}

export default function Sidebar({
  highlights,
  pins,
  fileName,
  scrolledToHighlightId,
  onJumpToHighlight,
  onDeleteHighlight,
  onClearHighlights,
  onOpenDive,
  onDeletePin,
  onUploadNew,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h2>Annotations</h2>
        <p className="sidebar-file">{fileName}</p>
        <p className="sidebar-count">
          {highlights.length} annotation{highlights.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="sidebar-list">
        {highlights.length === 0 ? (
          <div className="sidebar-empty">
            <p>No highlights yet</p>
            <p className="sidebar-hint">
              Select text to highlight, hold Alt and drag for area highlights,
              or use Note mode for sticky notes.
            </p>
          </div>
        ) : (
          highlights.map((highlight) => (
            <article
              key={highlight.id}
              className={`sidebar-item${
                scrolledToHighlightId === highlight.id ? " is-active" : ""
              }`}
            >
              <div
                role="button"
                tabIndex={0}
                className="sidebar-item-main"
                onClick={() => onJumpToHighlight(highlight)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onJumpToHighlight(highlight);
                  }
                }}
              >
                <span className="sidebar-item-type-row">
                  <span className="sidebar-item-type">{highlight.type}</span>
                  {highlight.divePanelId ? (
                    <DiveBadge onClick={() => onOpenDive(highlight.divePanelId!)} />
                  ) : null}
                </span>
                <span className="sidebar-item-page">
                  Page {highlight.position.boundingRect.pageNumber}
                </span>
                <span className="sidebar-item-text">
                  {highlightLabel(highlight)}
                </span>
                {highlight.comment ? (
                  <span className="sidebar-item-comment">{highlight.comment}</span>
                ) : null}
              </div>
              <button
                type="button"
                className="sidebar-item-delete"
                title="Delete annotation"
                onClick={() => onDeleteHighlight(highlight)}
              >
                Delete
              </button>
            </article>
          ))
        )}
      </div>

      <div className="sidebar-pins">
        <h3>Pins</h3>
        {pins.length === 0 ? (
          <p className="sidebar-empty-pins">No pins yet</p>
        ) : (
          <ul className="sidebar-pins-list">
            {pins.map((pin) => (
              <li key={pin.id} className="sidebar-pin">
                <span>{pin.text}</span>
                <button
                  type="button"
                  className="sidebar-pin-delete"
                  title="Delete pin"
                  onClick={() => onDeletePin(pin.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="sidebar-footer">
        <button type="button" onClick={onUploadNew}>
          Upload new PDF
        </button>
        {highlights.length > 0 ? (
          <button type="button" className="danger" onClick={onClearHighlights}>
            Clear all
          </button>
        ) : null}
      </footer>
    </aside>
  );
}
