import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from "react";
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Copy,
  CornerDownRight,
  Funnel,
  Highlighter,
  MessagesSquare,
  NotebookPen,
  Pencil,
  Pin as PinIcon,
  Plus,
  Search,
  SquareDashed,
  StickyNote,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useDocumentOutline } from "react-pdf-highlighter-plus";
import type { CommentedHighlight } from "../types";
import type { DiveHighlight, DivePanel, GeneralNote, Pin } from "../deepdive/types";
import { panelById, rootPanelOf } from "../deepdive/tree";
import { formatPageLabel } from "../pageLabels";
import { HIGHLIGHT_COLOR_NAMES, HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";

interface AnnotationsPanelProps {
  highlights: CommentedHighlight[];
  pins: Pin[];
  panels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToHighlightId: string | null;
  onJumpToHighlight: (highlight: CommentedHighlight) => void;
  onDeleteHighlight: (highlight: CommentedHighlight) => void;
  onEditHighlightComment: (highlight: CommentedHighlight, comment: string) => void;
  onEditFreetextText: (highlight: CommentedHighlight, text: string) => void;
  onHoverHighlight: (highlightId: string | null) => void;
  onOpenDiveFromHighlight: (highlight: CommentedHighlight) => void;
  onDeletePin: (pinId: string) => void;
  onEditPinComment: (pinId: string, comment: string) => void;
  onOpenDiveHighlight: (highlight: DiveHighlight) => void;
  onDeleteDiveHighlight: (highlightId: string) => void;
  onEditDiveHighlightComment: (highlightId: string, comment: string) => void;
  generalNotes: GeneralNote[];
  onAddNote: (text: string) => void;
  onEditGeneralNote: (id: string, text: string) => void;
  onDeleteGeneralNote: (id: string) => void;
  pageLabels: string[] | null;
  pdfDocument: PDFDocumentProxy | null;
  currentPage: number;
}

type AnnotationKind = "highlight" | "area" | "sticky" | "dive" | "pin" | "note";

const KINDS: { key: AnnotationKind; label: string; filterLabel: string; Icon: LucideIcon }[] = [
  { key: "highlight", label: "Highlight", filterLabel: "Highlights", Icon: Highlighter },
  { key: "area", label: "Area", filterLabel: "Area highlights", Icon: SquareDashed },
  { key: "sticky", label: "Sticky note", filterLabel: "Sticky notes", Icon: StickyNote },
  { key: "dive", label: "Dive highlight", filterLabel: "Deep-dive highlights", Icon: MessagesSquare },
  { key: "pin", label: "Pin", filterLabel: "Pins", Icon: PinIcon },
  { key: "note", label: "Note", filterLabel: "General notes", Icon: NotebookPen },
];

const KIND_BY_KEY = Object.fromEntries(KINDS.map((kind) => [kind.key, kind])) as Record<
  AnnotationKind,
  (typeof KINDS)[number]
>;

// Rows whose body is the reader's own words rather than a quoted passage.
const OWN_TEXT_KINDS = new Set<AnnotationKind>(["sticky", "note"]);

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SAVE_SHORTCUT = IS_MAC ? "⌘↵" : "Ctrl+↵";

interface AnnotationRow {
  id: string;
  kind: AnnotationKind;
  pageNumber?: number;
  // Fraction of the way down the page, for document order within a page.
  top: number;
  createdAt?: string;
  // Position in its source list (newest first) — the recency fallback for
  // highlights saved before createdAt was recorded.
  sourceIndex: number;
  text: string;
  // `text` is a stand-in label (e.g. an area highlight with no text), not
  // content to quote, search, or copy.
  textIsPlaceholder?: boolean;
  image?: string;
  comment?: string;
  color?: string;
  // For a dive highlight: the dive it was made in.
  context?: string;
  isActive: boolean;
  onOpen?: () => void;
  onDelete: () => void;
  // Set when a delete can't be undone with ⌘Z (or takes a dive conversation
  // with it) — the delete button then asks first, showing this.
  deleteWarning?: string;
  // A general note or sticky note (editsText) edits its own text, which
  // can't be emptied; every other kind edits the note attached to it, which
  // can be cleared to remove it.
  onEdit: (text: string) => void;
  editsText?: boolean;
  // Outlines the annotation's own highlight in the PDF while the row is
  // hovered — only PDF highlights have one on screen alongside this panel.
  onHover?: (hovered: boolean) => void;
  onOpenDive?: () => void;
}

interface Chapter {
  title: string;
  pageNumber: number;
}

type SortMode = "page" | "recent";

interface Filters {
  kinds: AnnotationKind[];
  colors: string[];
  withNotes: boolean;
  nearby: boolean;
}

const NO_FILTERS: Filters = { kinds: [], colors: [], withNotes: false, nearby: false };

interface RowGroup {
  key: string;
  title: string;
  rows: AnnotationRow[];
  // False when the group heading already names the page.
  showPage: boolean;
}

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsAnyTerm(text: string | undefined, terms: string[]): boolean {
  if (!text || terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

// Wraps every occurrence of a search term in <mark>.
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi"));
  return <>{parts.map((part, index) => (index % 2 === 1 ? <mark key={index}>{part}</mark> : part))}</>;
}

// Clamps `text` to `lines` lines, with a Show more/less toggle that only
// appears when there's actually more to show. While a search term is inside
// it, it shows everything (so the match isn't hidden) and hides the toggle.
function ClampedText({
  className,
  lines,
  text,
  terms,
}: {
  className: string;
  lines: number;
  text: string;
  terms: string[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const forceExpanded = containsAnyTerm(text, terms);
  const open = expanded || forceExpanded;

  // Only measurable while clamped; once expanded the last reading stands so
  // the "Show less" toggle stays.
  useLayoutEffect(() => {
    const element = ref.current;
    if (open || !element) return;
    const check = () => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);

  return (
    <>
      <div
        ref={ref}
        className={`${className} annot-clamp${open ? " is-expanded" : ""}`}
        style={{ "--annot-clamp-lines": lines } as CSSProperties}
      >
        <Highlighted text={text} terms={terms} />
      </div>
      {overflowing && !forceExpanded ? (
        <button
          type="button"
          className="annot-more"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

function AutoGrowTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [props.value]);

  // An autofocused note starts with the caret at the end, so editing an
  // existing note continues it.
  useEffect(() => {
    const element = ref.current;
    if (!element || document.activeElement !== element) return;
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  return <textarea ref={ref} rows={2} {...props} />;
}

// The inline editor for a note: a row's attached note, a sticky note's or
// general note's own text, or a brand new general note.
function NoteEditor({
  initialValue,
  placeholder,
  allowEmpty,
  onSave,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  allowEmpty: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const canSave = allowEmpty || Boolean(draft.trim());
  const save = () => {
    if (canSave) onSave(draft.trim());
  };

  return (
    <div className="annot-editor" onClick={(event) => event.stopPropagation()}>
      <AutoGrowTextarea
        className="annot-editor-textarea"
        value={draft}
        autoFocus
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            save();
          }
        }}
      />
      <div className="annot-editor-footer">
        <span className="annot-editor-hint">
          {SAVE_SHORTCUT} to save · Esc to cancel
        </span>
        <button type="button" className="annot-button annot-button--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="annot-button annot-button--primary" onClick={save} disabled={!canSave}>
          Save
        </button>
      </div>
    </div>
  );
}

// Runs `onOutside` on a mousedown outside `ref` or an Escape keypress, while
// `active` — for dismissing menus and pending confirmations.
function useDismiss(ref: RefObject<HTMLElement | null>, active: boolean, onOutside: () => void) {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutsideRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOutsideRef.current();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [ref, active]);
}

// Shows a check mark for a moment after a successful copy.
function useCopyFeedback(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => alert("Couldn't copy to the clipboard."));
  };
  return [copied, copy];
}

function pageSuffix(row: AnnotationRow, pageLabels: string[] | null): string {
  return row.pageNumber != null ? `p. ${formatPageLabel(pageLabels, row.pageNumber)}` : "";
}

function rowAsText(row: AnnotationRow, pageLabels: string[] | null): string {
  const page = pageSuffix(row, pageLabels);
  const body = row.textIsPlaceholder
    ? `[${row.text}]`
    : OWN_TEXT_KINDS.has(row.kind)
      ? row.text
      : `“${row.text}”`;
  const lines = [page ? `${body} (${page})` : body];
  if (row.comment) lines.push(`Note: ${row.comment}`);
  return lines.join("\n");
}

function groupsAsMarkdown(groups: RowGroup[], pageLabels: string[] | null): string {
  const indent = (text: string) => text.replace(/\n/g, "\n  ");
  return groups
    .map((group) => {
      const items = group.rows.map((row) => {
        const lines = rowAsText(row, pageLabels).split("\nNote: ");
        const item = `- ${KIND_BY_KEY[row.kind].label}: ${indent(lines[0])}`;
        return lines[1] ? `${item}\n  - Note: ${indent(indent(lines[1]))}` : item;
      });
      return [`## ${group.title}`, "", ...items].join("\n");
    })
    .join("\n\n");
}

function AnnotationCard({
  row,
  terms,
  showPage,
  pageLabels,
}: {
  row: AnnotationRow;
  terms: string[];
  showPage: boolean;
  pageLabels: string[] | null;
}) {
  const editsText = Boolean(row.editsText);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copied, copy] = useCopyFeedback();
  const cardRef = useRef<HTMLElement>(null);
  useDismiss(cardRef, confirmingDelete, () => setConfirmingDelete(false));

  // A row deleted (or filtered out) while hovered never gets mouseleave, so
  // clear the PDF outline when it unmounts instead.
  const hoveredRef = useRef(false);
  const onHoverRef = useRef(row.onHover);
  onHoverRef.current = row.onHover;
  useEffect(
    () => () => {
      if (hoveredRef.current) onHoverRef.current?.(false);
    },
    [],
  );
  const setHovered = (hovered: boolean) => {
    hoveredRef.current = hovered;
    row.onHover?.(hovered);
  };

  useEffect(() => {
    if (row.isActive) cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [row.isActive]);

  const save = (value: string) => {
    const current = editsText ? row.text : (row.comment ?? "");
    if ((value || !editsText) && value !== current) row.onEdit(value);
    setEditing(false);
  };

  const { Icon, label } = KIND_BY_KEY[row.kind];
  const editLabel = editsText || row.comment ? "Edit note" : "Add note";
  // While editing, the card body is static so clicks inside the editor
  // don't also jump to the annotation. A general note has nowhere to jump
  // to, so clicking it starts editing instead.
  const onOpen = editing ? undefined : row.kind === "note" ? () => setEditing(true) : row.onOpen;
  const page = showPage ? pageSuffix(row, pageLabels) : "";

  const editor = editing ? (
    <NoteEditor
      initialValue={editsText ? row.text : (row.comment ?? "")}
      placeholder={editsText ? "Write a note…" : "Add a note about this…"}
      allowEmpty={!editsText}
      onSave={save}
      onCancel={() => setEditing(false)}
    />
  ) : null;

  return (
    <article
      ref={cardRef}
      className={`annot-card annot-card--${row.kind}${row.isActive ? " is-active" : ""}${
        row.color ? " has-color" : ""
      }${confirmingDelete ? " is-confirming" : ""}`}
      style={row.color ? ({ "--annot-color": row.color } as CSSProperties) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`annot-card-body${onOpen ? " is-clickable" : ""}`}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
        title={onOpen && row.kind !== "note" ? (row.kind === "dive" ? "Open in its dive" : "Go to page") : undefined}
        onClick={onOpen}
        onKeyDown={(event) => {
          // Only the card itself — Enter on a button inside it is that
          // button's own click.
          if (!onOpen || event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="annot-card-meta">
          <Icon className="annot-card-icon" width={13} height={13} strokeWidth={2} aria-hidden="true" />
          <span>{label}</span>
          {page ? <span className="annot-card-page">· {page}</span> : null}
          {row.onOpenDive ? (
            <button
              type="button"
              className="annot-dive-link"
              title="Open its deep dive"
              onClick={(event) => {
                event.stopPropagation();
                row.onOpenDive!();
              }}
            >
              <MessagesSquare width={11} height={11} strokeWidth={2.25} aria-hidden="true" />
              Dive
            </button>
          ) : null}
        </div>

        {row.context ? (
          <div className="annot-card-context" title={row.context}>
            <CornerDownRight width={12} height={12} aria-hidden="true" />
            <span>in “{row.context}”</span>
          </div>
        ) : null}

        {row.image ? <img className="annot-card-image" src={row.image} alt="" /> : null}

        {editing && editsText ? (
          editor
        ) : row.textIsPlaceholder ? (
          // Only when there's nothing else to show in the card.
          row.image || row.comment ? null : <div className="annot-card-placeholder">{row.text}</div>
        ) : (
          <ClampedText
            className={`annot-card-text${OWN_TEXT_KINDS.has(row.kind) ? " is-own" : " is-quote"}`}
            lines={OWN_TEXT_KINDS.has(row.kind) ? 6 : 4}
            text={row.text}
            terms={terms}
          />
        )}

        {editing && !editsText ? (
          editor
        ) : row.comment ? (
          <div className="annot-card-comment">
            <ClampedText className="annot-card-comment-text" lines={4} text={row.comment} terms={terms} />
          </div>
        ) : null}
      </div>

      {confirmingDelete ? (
        <div className="annot-confirm" role="alertdialog" aria-label="Confirm delete">
          <span className="annot-confirm-text">
            Delete this {label.toLowerCase()}? {row.deleteWarning}
          </span>
          <button type="button" className="annot-button annot-button--quiet" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </button>
          <button type="button" className="annot-button annot-button--danger" autoFocus onClick={row.onDelete}>
            Delete
          </button>
        </div>
      ) : (
        <div className="annot-card-actions">
          {!row.textIsPlaceholder || row.comment ? (
            <button
              type="button"
              className="annot-card-action"
              title={copied ? "Copied" : "Copy"}
              aria-label="Copy"
              onClick={() => copy(rowAsText(row, pageLabels))}
            >
              {copied ? <Check width={14} height={14} strokeWidth={2} /> : <Copy width={14} height={14} strokeWidth={2} />}
            </button>
          ) : null}
          {!editing ? (
            <button
              type="button"
              className="annot-card-action"
              title={editLabel}
              aria-label={editLabel}
              onClick={() => setEditing(true)}
            >
              <Pencil width={14} height={14} strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            className="annot-card-action annot-card-action--danger"
            title={row.deleteWarning ? "Delete…" : "Delete (⌘Z to undo)"}
            aria-label="Delete"
            onClick={() => (row.deleteWarning ? setConfirmingDelete(true) : row.onDelete())}
          >
            <Trash2 width={14} height={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </article>
  );
}

function FiltersMenu({
  filters,
  onChange,
  kindCounts,
  colorsInUse,
  nearbyLabel,
}: {
  filters: Filters;
  onChange: (filters: Filters) => void;
  kindCounts: Record<AnnotationKind, number>;
  colorsInUse: string[];
  nearbyLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(containerRef, open, () => setOpen(false));
  const activeCount =
    filters.kinds.length + filters.colors.length + Number(filters.withNotes) + Number(filters.nearby);

  return (
    <div className="annot-filters" ref={containerRef}>
      <button
        type="button"
        className={`annot-toolbar-button${activeCount > 0 ? " is-active" : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        <Funnel width={13} height={13} strokeWidth={2.25} aria-hidden="true" />
        Filter
        {activeCount > 0 ? <span className="annot-filters-count">{activeCount}</span> : null}
        <ChevronDown className="annot-filters-chevron" width={13} height={13} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {open ? (
        <div className="annot-filters-menu">
          <p className="annot-filters-heading">Type</p>
          {KINDS.map(({ key, filterLabel, Icon }) => (
            <label key={key} className={`annot-filters-item${kindCounts[key] === 0 ? " is-empty" : ""}`}>
              <input
                type="checkbox"
                checked={filters.kinds.includes(key)}
                onChange={() => onChange({ ...filters, kinds: toggled(filters.kinds, key) })}
              />
              <Icon width={13} height={13} strokeWidth={2} aria-hidden="true" />
              <span className="annot-filters-item-label">{filterLabel}</span>
              <span className="annot-filters-item-count">{kindCounts[key]}</span>
            </label>
          ))}

          {colorsInUse.length > 1 ? (
            <>
              <p className="annot-filters-heading">Color</p>
              <div className="annot-filters-swatches">
                {colorsInUse.map((color) => {
                  const selected = filters.colors.includes(color);
                  const name = HIGHLIGHT_COLOR_NAMES[color] ?? "Custom";
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`annot-swatch${selected ? " is-selected" : ""}`}
                      style={{ background: color }}
                      title={name}
                      aria-label={name}
                      aria-pressed={selected}
                      onClick={() => onChange({ ...filters, colors: toggled(filters.colors, color) })}
                    >
                      {selected ? <Check width={12} height={12} strokeWidth={3} aria-hidden="true" /> : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          <p className="annot-filters-heading">Show only</p>
          <label className="annot-filters-item">
            <input
              type="checkbox"
              checked={filters.withNotes}
              onChange={() => onChange({ ...filters, withNotes: !filters.withNotes })}
            />
            <span className="annot-filters-item-label">With a note</span>
          </label>
          <label className="annot-filters-item">
            <input
              type="checkbox"
              checked={filters.nearby}
              onChange={() => onChange({ ...filters, nearby: !filters.nearby })}
            />
            <span className="annot-filters-item-label">{nearbyLabel}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

// Finds the top-level chapter currentPage falls in and returns its page
// range [start, end] (end is the page before the next chapter starts, or
// +Infinity for the last chapter) — the basis for the "Current chapter"
// filter.
function chapterRangeForPage(chapters: Chapter[] | null, currentPage: number): [number, number] | null {
  if (!chapters || chapters.length === 0) return null;
  const activeIndex = chapterIndexForPage(chapters, currentPage);
  if (activeIndex === -1) return [1, chapters[0].pageNumber - 1];
  const next = chapters[activeIndex + 1];
  return [chapters[activeIndex].pageNumber, next ? next.pageNumber - 1 : Number.POSITIVE_INFINITY];
}

function chapterIndexForPage(chapters: Chapter[], pageNumber: number): number {
  let index = -1;
  chapters.forEach((chapter, chapterIndex) => {
    if (chapter.pageNumber <= pageNumber) index = chapterIndex;
  });
  return index;
}

function dayLabel(iso: string | undefined): string {
  if (!iso) return "Earlier";
  const date = new Date(iso);
  const today = new Date();
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

// Newest first; rows with no createdAt (older highlights) go last, in the
// order they were added.
function compareRecent(a: AnnotationRow, b: AnnotationRow): number {
  if (a.createdAt && b.createdAt) return b.createdAt.localeCompare(a.createdAt);
  if (a.createdAt) return -1;
  if (b.createdAt) return 1;
  return a.sourceIndex - b.sourceIndex;
}

// A dive highlight shares its anchor highlight's page and position, so it
// sorts right after it.
const DOCUMENT_KIND_RANK: Record<AnnotationKind, number> = {
  highlight: 0,
  area: 0,
  sticky: 0,
  dive: 1,
  pin: 2,
  note: 2,
};

function compareDocument(a: AnnotationRow, b: AnnotationRow): number {
  return (
    (a.pageNumber ?? 0) - (b.pageNumber ?? 0) ||
    a.top - b.top ||
    DOCUMENT_KIND_RANK[a.kind] - DOCUMENT_KIND_RANK[b.kind] ||
    compareRecent(b, a)
  );
}

function groupRows(
  rows: AnnotationRow[],
  sort: SortMode,
  chapters: Chapter[] | null,
  pageLabels: string[] | null,
): RowGroup[] {
  const groups: RowGroup[] = [];
  const push = (key: string, title: string, row: AnnotationRow, showPage: boolean) => {
    const last = groups[groups.length - 1];
    if (last?.key === key) last.rows.push(row);
    else groups.push({ key, title, rows: [row], showPage });
  };

  if (sort === "recent") {
    [...rows].sort(compareRecent).forEach((row) => {
      const title = dayLabel(row.createdAt);
      push(title, title, row, true);
    });
    return groups;
  }

  // Page order: general notes (about the whole document) first, then
  // everything placed in the document by chapter — or by page, for a PDF
  // without an outline — then whatever has no place in it.
  const notes = rows.filter((row) => row.kind === "note").sort(compareRecent);
  const placed = rows.filter((row) => row.kind !== "note" && row.pageNumber != null).sort(compareDocument);
  const unplaced = rows.filter((row) => row.kind !== "note" && row.pageNumber == null).sort(compareRecent);

  notes.forEach((row) => push("notes", "General notes", row, false));
  placed.forEach((row) => {
    const pageNumber = row.pageNumber!;
    if (chapters && chapters.length > 0) {
      const index = chapterIndexForPage(chapters, pageNumber);
      push(`chapter-${index}`, index === -1 ? "Front matter" : chapters[index].title, row, true);
    } else {
      push(`page-${pageNumber}`, `Page ${formatPageLabel(pageLabels, pageNumber)}`, row, false);
    }
  });
  unplaced.forEach((row) => push("unplaced", "From deep dives", row, false));
  return groups;
}

export default function AnnotationsPanel(props: AnnotationsPanelProps) {
  // useDocumentOutline requires a non-null document, so the chapter lookup
  // only mounts (and only runs its hook) once PdfPane has reported one via
  // onDocumentReady — mirrors TableOfContentsPanel's own split for the same
  // reason.
  return props.pdfDocument ? (
    <AnnotationsPanelWithOutline {...props} pdfDocument={props.pdfDocument} />
  ) : (
    <AnnotationsPanelBody {...props} chapters={null} />
  );
}

// flatOutline flattens every level of the outline (chapters *and* their
// nested subsections) into one document-ordered list, so it's narrowed down
// to just the top-level entries (the lowest `level` present) — otherwise
// grouping and the "Current chapter" filter would work per subsection.
function AnnotationsPanelWithOutline(props: AnnotationsPanelProps & { pdfDocument: PDFDocumentProxy }) {
  const { flatOutline } = useDocumentOutline({ pdfDocument: props.pdfDocument });
  const chapters = useMemo(() => {
    if (!flatOutline || flatOutline.length === 0) return null;
    const minLevel = Math.min(...flatOutline.map((item) => item.level));
    return flatOutline
      .filter((item) => item.level === minLevel)
      .map((item) => ({ title: item.title, pageNumber: item.pageNumber }));
  }, [flatOutline]);
  return <AnnotationsPanelBody {...props} chapters={chapters} />;
}

function AnnotationsPanelBody({
  highlights,
  pins,
  panels,
  diveHighlights,
  scrolledToHighlightId,
  onJumpToHighlight,
  onDeleteHighlight,
  onEditHighlightComment,
  onEditFreetextText,
  onHoverHighlight,
  onOpenDiveFromHighlight,
  onDeletePin,
  onEditPinComment,
  onOpenDiveHighlight,
  onDeleteDiveHighlight,
  onEditDiveHighlightComment,
  generalNotes,
  onAddNote,
  onEditGeneralNote,
  onDeleteGeneralNote,
  pageLabels,
  currentPage,
  chapters,
}: AnnotationsPanelProps & { chapters: Chapter[] | null }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortMode>("page");
  const [composing, setComposing] = useState(false);
  const [copiedAll, copyAll] = useCopyFeedback();
  const searchRef = useRef<HTMLInputElement>(null);

  const rows: AnnotationRow[] = useMemo(() => {
    const highlightRows = highlights.map((highlight, sourceIndex): AnnotationRow => {
      const kind: AnnotationKind =
        highlight.type === "freetext" ? "sticky" : highlight.type === "area" ? "area" : "highlight";
      const rect = highlight.position.boundingRect;
      const text = highlight.content?.text?.trim();
      return {
        id: highlight.id,
        kind,
        pageNumber: rect.pageNumber,
        top: rect.height ? rect.y1 / rect.height : 0,
        createdAt: highlight.createdAt,
        sourceIndex,
        text: text || (kind === "sticky" ? "Empty sticky note" : kind === "area" ? "Area highlight" : "Highlight"),
        textIsPlaceholder: !text,
        image: kind === "area" ? highlight.content?.image : undefined,
        comment: highlight.comment,
        color: kind === "highlight" ? (highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0]) : undefined,
        isActive: scrolledToHighlightId === highlight.id,
        onOpen: () => onJumpToHighlight(highlight),
        onDelete: () => onDeleteHighlight(highlight),
        deleteWarning: highlight.divePanelId
          ? "This also deletes its deep dive conversation."
          : undefined,
        ...(kind === "sticky"
          ? { editsText: true, onEdit: (value: string) => onEditFreetextText(highlight, value) }
          : { onEdit: (comment: string) => onEditHighlightComment(highlight, comment) }),
        onHover: (hovered: boolean) => onHoverHighlight(hovered ? highlight.id : null),
        onOpenDive: highlight.divePanelId ? () => onOpenDiveFromHighlight(highlight) : undefined,
      };
    });

    // A dive highlight has no page of its own; it takes the page of the
    // main-text highlight its dive branch started from.
    const diveRows = diveHighlights.map((highlight, sourceIndex): AnnotationRow => {
      const root = rootPanelOf(panels, highlight.panelId);
      const anchorRect = root?.anchorHighlightId
        ? highlights.find((h) => h.id === root.anchorHighlightId)?.position.boundingRect
        : undefined;
      return {
        id: highlight.id,
        kind: "dive",
        pageNumber: anchorRect?.pageNumber,
        top: anchorRect?.height ? anchorRect.y1 / anchorRect.height : 0,
        createdAt: highlight.createdAt,
        sourceIndex,
        text: highlight.text,
        comment: highlight.comment,
        color: highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0],
        context: panelById(panels, highlight.panelId)?.label ?? "a deep dive",
        isActive: false,
        onOpen: () => onOpenDiveHighlight(highlight),
        onDelete: () => onDeleteDiveHighlight(highlight.id),
        deleteWarning: highlight.divePanelId
          ? "This also deletes the dive started from it. This can't be undone."
          : "This can't be undone.",
        onEdit: (comment: string) => onEditDiveHighlightComment(highlight.id, comment),
      };
    });

    const pinRows = pins.map(
      (pin, sourceIndex): AnnotationRow => ({
        id: pin.id,
        kind: "pin",
        top: 0,
        createdAt: pin.createdAt,
        sourceIndex,
        text: pin.text,
        comment: pin.comment,
        isActive: false,
        onDelete: () => onDeletePin(pin.id),
        deleteWarning: "This can't be undone.",
        onEdit: (comment: string) => onEditPinComment(pin.id, comment),
      }),
    );

    const noteRows = generalNotes.map(
      (note, sourceIndex): AnnotationRow => ({
        id: note.id,
        kind: "note",
        top: 0,
        createdAt: note.createdAt,
        sourceIndex,
        text: note.text,
        isActive: false,
        onDelete: () => onDeleteGeneralNote(note.id),
        deleteWarning: "This can't be undone.",
        onEdit: (text: string) => onEditGeneralNote(note.id, text),
        editsText: true,
      }),
    );

    return [...highlightRows, ...diveRows, ...pinRows, ...noteRows];
  }, [
    highlights,
    diveHighlights,
    pins,
    generalNotes,
    panels,
    scrolledToHighlightId,
    onJumpToHighlight,
    onDeleteHighlight,
    onEditHighlightComment,
    onEditFreetextText,
    onHoverHighlight,
    onOpenDiveFromHighlight,
    onOpenDiveHighlight,
    onDeleteDiveHighlight,
    onEditDiveHighlightComment,
    onDeletePin,
    onEditPinComment,
    onEditGeneralNote,
    onDeleteGeneralNote,
  ]);

  const kindCounts = useMemo(() => {
    const counts = Object.fromEntries(KINDS.map(({ key }) => [key, 0])) as Record<AnnotationKind, number>;
    rows.forEach((row) => counts[row.kind]++);
    return counts;
  }, [rows]);

  const colorsInUse = useMemo(() => {
    const used = new Set(rows.map((row) => row.color).filter((color): color is string => Boolean(color)));
    // Presets in their menu order, then any others.
    return [...HIGHLIGHT_COLOR_PRESETS.filter((color) => used.has(color)), ...[...used].filter((color) => !HIGHLIGHT_COLOR_PRESETS.includes(color))];
  }, [rows]);

  const chapterRange = useMemo(() => chapterRangeForPage(chapters, currentPage), [chapters, currentPage]);
  const [nearbyStart, nearbyEnd] = chapterRange ?? [currentPage, currentPage];
  const nearbyLabel = chapterRange ? "In the current chapter" : "On the current page";

  const terms = useMemo(() => searchTerms(query), [query]);

  // Types OR together (a row is only ever one type); every other kind of
  // filter, and each search term, must also match.
  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (filters.kinds.length > 0 && !filters.kinds.includes(row.kind)) return false;
        if (filters.colors.length > 0 && (!row.color || !filters.colors.includes(row.color))) return false;
        if (filters.withNotes && !row.comment && !OWN_TEXT_KINDS.has(row.kind)) return false;
        if (filters.nearby) {
          if (row.pageNumber == null || row.pageNumber < nearbyStart || row.pageNumber > nearbyEnd) return false;
        }
        if (terms.length > 0) {
          const haystack = [
            row.textIsPlaceholder ? "" : row.text,
            row.comment,
            row.context,
            KIND_BY_KEY[row.kind].label,
            row.pageNumber != null ? `p. ${formatPageLabel(pageLabels, row.pageNumber)}` : "",
          ]
            .join("\n")
            .toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) return false;
        }
        return true;
      }),
    [rows, filters, nearbyStart, nearbyEnd, terms, pageLabels],
  );

  const groups = useMemo(
    () => groupRows(filteredRows, sort, chapters, pageLabels),
    [filteredRows, sort, chapters, pageLabels],
  );

  const activeChips: { key: string; label: ReactNode; remove: () => void }[] = [
    ...filters.kinds.map((kind) => ({
      key: `kind-${kind}`,
      label: KIND_BY_KEY[kind].filterLabel,
      remove: () => setFilters((f) => ({ ...f, kinds: f.kinds.filter((k) => k !== kind) })),
    })),
    ...filters.colors.map((color) => ({
      key: `color-${color}`,
      label: (
        <>
          <span className="annot-chip-swatch" style={{ background: color }} />
          {HIGHLIGHT_COLOR_NAMES[color] ?? "Custom"}
        </>
      ),
      remove: () => setFilters((f) => ({ ...f, colors: f.colors.filter((c) => c !== color) })),
    })),
    ...(filters.withNotes
      ? [{ key: "notes", label: "With a note", remove: () => setFilters((f) => ({ ...f, withNotes: false })) }]
      : []),
    ...(filters.nearby
      ? [{ key: "nearby", label: nearbyLabel, remove: () => setFilters((f) => ({ ...f, nearby: false })) }]
      : []),
  ];
  const narrowed = activeChips.length > 0 || terms.length > 0;

  const clearAll = () => {
    setFilters(NO_FILTERS);
    setQuery("");
  };

  return (
    <>
      <header className="sidebar-header annot-header">
        <h2>Annotations</h2>
        <p className="sidebar-count">
          {narrowed ? `${filteredRows.length} of ${rows.length}` : rows.length} annotation
          {rows.length === 1 ? "" : "s"}
        </p>

        <div className="search-field">
          <Search className="search-field-icon" width={15} height={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="Search highlights and notes"
            aria-label="Search annotations"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="search-field-clear"
              title="Clear"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X width={14} height={14} />
            </button>
          ) : null}
        </div>

        <div className="annot-toolbar">
          <FiltersMenu
            filters={filters}
            onChange={setFilters}
            kindCounts={kindCounts}
            colorsInUse={colorsInUse}
            nearbyLabel={nearbyLabel}
          />
          <select
            className="annot-toolbar-button annot-sort"
            value={sort}
            aria-label="Sort annotations"
            onChange={(event) => setSort(event.target.value as SortMode)}
          >
            <option value="page">By page</option>
            <option value="recent">Newest</option>
          </select>
          <span className="annot-toolbar-spacer" />
          <button
            type="button"
            className="annot-toolbar-button annot-toolbar-icon"
            title={copiedAll ? "Copied" : "Copy shown annotations as Markdown"}
            aria-label="Copy shown annotations as Markdown"
            disabled={filteredRows.length === 0}
            onClick={() => copyAll(groupsAsMarkdown(groups, pageLabels))}
          >
            {copiedAll ? <Check width={14} height={14} strokeWidth={2.25} /> : <ClipboardCopy width={14} height={14} strokeWidth={2} />}
          </button>
          <button
            type="button"
            className="annot-toolbar-button annot-new-note"
            title="Write a note about the whole document"
            onClick={() => setComposing(true)}
            disabled={composing}
          >
            <Plus width={14} height={14} strokeWidth={2.5} aria-hidden="true" />
            Note
          </button>
        </div>

        {activeChips.length > 0 ? (
          <div className="annot-chips">
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                className="annot-chip"
                title="Remove filter"
                onClick={chip.remove}
              >
                {chip.label}
                <X width={11} height={11} strokeWidth={2.5} aria-hidden="true" />
              </button>
            ))}
            <button type="button" className="annot-chips-clear" onClick={() => setFilters(NO_FILTERS)}>
              Clear
            </button>
          </div>
        ) : null}
      </header>

      <div className="sidebar-list annot-list">
        {composing ? (
          <div className="annot-composer">
            <NoteEditor
              initialValue=""
              placeholder="A note about this document — not tied to any page"
              allowEmpty={false}
              onSave={(text) => {
                onAddNote(text);
                setComposing(false);
              }}
              onCancel={() => setComposing(false)}
            />
          </div>
        ) : null}

        {rows.length === 0 ? (
          composing ? null : (
            <div className="sidebar-empty">
              <p>No annotations yet</p>
              <ul className="annot-empty-tips">
                <li>Select text in the PDF to highlight it and add a note.</li>
                <li>Right-click the page for a sticky note at that spot.</li>
                <li>Hold Alt and drag for an area highlight.</li>
                <li>Use <strong>+ Note</strong> above for a note about the whole document.</li>
              </ul>
            </div>
          )
        ) : groups.length === 0 ? (
          <div className="sidebar-empty">
            <p>Nothing matches {terms.length > 0 ? `“${query.trim()}”` : "these filters"}.</p>
            <button type="button" className="annot-button annot-button--quiet annot-empty-clear" onClick={clearAll}>
              Clear search and filters
            </button>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="annot-group">
              <h3 className="search-group-heading annot-group-heading">
                <span className="annot-group-title" title={group.title}>
                  {group.title}
                </span>
                <span className="search-group-count">{group.rows.length}</span>
              </h3>
              {group.rows.map((row) => (
                <AnnotationCard
                  key={`${row.kind}-${row.id}`}
                  row={row}
                  terms={terms}
                  showPage={group.showPage}
                  pageLabels={pageLabels}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </>
  );
}
