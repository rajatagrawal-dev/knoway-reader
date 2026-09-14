import {
  cloneElement,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { DiveHighlight, DivePanel } from "./types";
import { childrenOf } from "./tree";
import { useSelectionCapture } from "./useSelectionCapture";
import DiveSelectionTip from "./DiveSelectionTip";
import DiveHighlightMark from "./DiveHighlightMark";
import DiveHighlightEditTip from "./DiveHighlightEditTip";
import { normalizeMathNotation } from "./mathNotation";

export interface DivePanelPaneProps {
  panel: DivePanel;
  allPanels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  onOpenDive: (panelId: string) => void;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string }) => void;
  onAddHighlight: (
    panelId: string,
    text: string,
    comment: string,
    style?: Pick<DiveHighlight, "highlightColor" | "highlightStyle">,
  ) => void;
  onEditHighlight: (
    highlightId: string,
    edit: Partial<Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "comment" | "divePanelId">>,
  ) => void;
  onDeleteHighlight: (highlightId: string) => void;
  onDiveFromHighlight: (highlight: DiveHighlight, contextText: string) => void;
  onPin: (selection: string, contextText: string) => void;
}

const HIGHLIGHT_DIVE_CONTEXT_LENGTH = 1000;

// Mirrors useSelectionCapture's own context extraction (nearest container's
// text, truncated) for the case where there's no live browser selection to
// read from — diving from an already-placed highlight instead of a fresh
// one — by finding the turn the highlight's text lives in and using that.
function contextForHighlight(panel: DivePanel, highlight: DiveHighlight): string {
  const turn = panel.turns.find((t) => t.content.includes(highlight.text));
  return (turn?.content ?? highlight.text).slice(0, HIGHLIGHT_DIVE_CONTEXT_LENGTH);
}

interface TextAnnotation {
  start: number;
  end: number;
  wrap: (node: ReactNode) => ReactNode;
}

// Wraps any substring of `text` matching one of `children`'s `selection`,
// or one of `diveHighlights`' `text`, in a marker/highlight element. Each
// source is matched independently (first occurrence only), merged into one
// list sorted by position, and overlapping matches are dropped (first match
// wins, highlights taking priority over markers at a tie) — approximate on
// purpose: this is a self-use app, not a rich-text editor.
function wrapAnnotationsInText(
  text: string,
  children: DivePanel[],
  diveHighlights: DiveHighlight[],
  scrolledToDiveHighlightId: string | null,
  editingHighlightId: string | null,
  onOpenDive: (panelId: string) => void,
  onHighlightClick: (highlight: DiveHighlight, anchorRect: DOMRect) => void,
): ReactNode {
  if (children.length === 0 && diveHighlights.length === 0) return text;

  const annotations: TextAnnotation[] = [];
  for (const highlight of diveHighlights) {
    const start = text.indexOf(highlight.text);
    if (start === -1) continue;
    annotations.push({
      start,
      end: start + highlight.text.length,
      wrap: (node) => (
        <DiveHighlightMark
          highlight={highlight}
          isScrolledTo={scrolledToDiveHighlightId === highlight.id}
          isEditing={editingHighlightId === highlight.id}
          onClick={onHighlightClick}
        >
          {node}
        </DiveHighlightMark>
      ),
    });
  }
  for (const child of children) {
    if (!child.selection) continue;
    const start = text.indexOf(child.selection);
    if (start === -1) continue;
    annotations.push({
      start,
      end: start + child.selection.length,
      wrap: (node) => (
        <button
          type="button"
          className="dive-turn-marker"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDive(child.id);
          }}
        >
          {node}
        </button>
      ),
    });
  }
  if (annotations.length === 0) return text;

  annotations.sort((a, b) => a.start - b.start);
  const nonOverlapping: TextAnnotation[] = [];
  let cursor = 0;
  for (const annotation of annotations) {
    if (annotation.start < cursor) continue;
    nonOverlapping.push(annotation);
    cursor = annotation.end;
  }

  const nodes: ReactNode[] = [];
  let pos = 0;
  nonOverlapping.forEach((annotation, index) => {
    if (annotation.start > pos) nodes.push(text.slice(pos, annotation.start));
    nodes.push(<Fragment key={index}>{annotation.wrap(text.slice(annotation.start, annotation.end))}</Fragment>);
    pos = annotation.end;
  });
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

// Applies wrapAnnotationsInText to the plain-string children of a rendered
// markdown element, recursing into inline-formatting elements (<strong>,
// <em>, <code>, ...) so a dived-into phrase or highlight still applies even
// when part of it is bold/italic/etc.
function wrapAnnotationChildren(
  node: ReactNode,
  children: DivePanel[],
  diveHighlights: DiveHighlight[],
  scrolledToDiveHighlightId: string | null,
  editingHighlightId: string | null,
  onOpenDive: (panelId: string) => void,
  onHighlightClick: (highlight: DiveHighlight, anchorRect: DOMRect) => void,
): ReactNode {
  if (typeof node === "string") {
    return wrapAnnotationsInText(
      node,
      children,
      diveHighlights,
      scrolledToDiveHighlightId,
      editingHighlightId,
      onOpenDive,
      onHighlightClick,
    );
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragment key={index}>
        {wrapAnnotationChildren(
          child,
          children,
          diveHighlights,
          scrolledToDiveHighlightId,
          editingHighlightId,
          onOpenDive,
          onHighlightClick,
        )}
      </Fragment>
    ));
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(
      node,
      undefined,
      wrapAnnotationChildren(
        node.props.children,
        children,
        diveHighlights,
        scrolledToDiveHighlightId,
        editingHighlightId,
        onOpenDive,
        onHighlightClick,
      ),
    );
  }
  return node;
}

// True when a paragraph's only meaningful content is a single KaTeX span —
// i.e. the model wrote a standalone equation as inline math ($...$) in its
// own paragraph rather than a display block ($$...$$). Both are meant to
// read as "an equation on its own line," so this gets the same centered
// treatment as a true display equation regardless of which delimiter the
// model happened to use.
function isSoleEquationParagraph(node: ReactNode): boolean {
  const items = (Array.isArray(node) ? node : [node]).filter(
    (item) => !(typeof item === "string" && item.trim() === ""),
  );
  if (items.length !== 1) return false;
  const [only] = items;
  return (
    isValidElement<{ className?: string }>(only) &&
    typeof only.props.className === "string" &&
    only.props.className.split(" ").includes("katex")
  );
}

// `components` is passed to every ReactMarkdown instance in this panel and
// must stay referentially stable across renders — react-markdown's custom
// component functions are compared by reference, so a fresh object here on
// every render (e.g. from local UI state changing elsewhere in this
// component) makes React treat <p>/<li>/etc. as brand-new component types
// and remount their DOM nodes, silently clearing any browser text
// selection the user just made inside them.
function useMarkdownComponents(
  children: DivePanel[],
  diveHighlights: DiveHighlight[],
  scrolledToDiveHighlightId: string | null,
  editingHighlightId: string | null,
  onOpenDive: (panelId: string) => void,
  onHighlightClick: (highlight: DiveHighlight, anchorRect: DOMRect) => void,
): Components {
  return useMemo(() => {
    const wrap = (node: ReactNode) =>
      wrapAnnotationChildren(
        node,
        children,
        diveHighlights,
        scrolledToDiveHighlightId,
        editingHighlightId,
        onOpenDive,
        onHighlightClick,
      );
    return {
      p: ({ children: c }) => (
        <p className={isSoleEquationParagraph(c) ? "dive-equation-line" : undefined}>{wrap(c)}</p>
      ),
      li: ({ children: c }) => <li>{wrap(c)}</li>,
      h1: ({ children: c }) => <h1>{wrap(c)}</h1>,
      h2: ({ children: c }) => <h2>{wrap(c)}</h2>,
      h3: ({ children: c }) => <h3>{wrap(c)}</h3>,
      td: ({ children: c }) => <td>{wrap(c)}</td>,
      th: ({ children: c }) => <th>{wrap(c)}</th>,
    };
  }, [children, diveHighlights, scrolledToDiveHighlightId, editingHighlightId, onOpenDive, onHighlightClick]);
}

function renderTurnContent(content: string, components: Components): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
      components={components}
    >
      {normalizeMathNotation(content)}
    </ReactMarkdown>
  );
}

// Cycles "Thinking.", "Thinking..", "Thinking..." while we wait for the
// first chunk of a streamed reply, so the pane doesn't look stalled.
function ThinkingIndicator() {
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const id = setInterval(() => setDots((prev) => (prev % 3) + 1), 400);
    return () => clearInterval(id);
  }, []);

  return <span>Thinking{".".repeat(dots)}</span>;
}

export default function DivePanelPane({
  panel,
  allPanels,
  diveHighlights,
  scrolledToDiveHighlightId,
  onOpenDive,
  onSendMessage,
  onNestedDive,
  onAddHighlight,
  onEditHighlight,
  onDeleteHighlight,
  onDiveFromHighlight,
  onPin,
}: DivePanelPaneProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [editingHighlight, setEditingHighlight] = useState<{
    highlightId: string;
    position: { x: number; y: number };
  } | null>(null);
  const dialogueRef = useRef<HTMLDivElement>(null);
  const { captured, clear } = useSelectionCapture(dialogueRef, ".dive-turn");
  const children = useMemo(() => childrenOf(allPanels, panel.id), [allPanels, panel.id]);
  const panelHighlights = useMemo(
    () => diveHighlights.filter((highlight) => highlight.panelId === panel.id),
    [diveHighlights, panel.id],
  );
  // Re-derived from `panelHighlights` (rather than kept in `editingHighlight`
  // itself) so the edit tip reflects the highlight's latest color/style/
  // comment immediately after each edit, instead of the stale snapshot taken
  // when it was clicked.
  const editingHighlightObj = editingHighlight
    ? panelHighlights.find((highlight) => highlight.id === editingHighlight.highlightId)
    : undefined;

  const handleHighlightClick = useCallback((highlight: DiveHighlight, anchorRect: DOMRect) => {
    setEditingHighlight({ highlightId: highlight.id, position: { x: anchorRect.left, y: anchorRect.bottom + 6 } });
  }, []);

  const markdownComponents = useMarkdownComponents(
    children,
    panelHighlights,
    scrolledToDiveHighlightId,
    editingHighlight?.highlightId ?? null,
    onOpenDive,
    handleHighlightClick,
  );

  // Opened from the annotations panel: scroll the note's highlighted phrase
  // into view. The mark carries the highlight's id as a data attribute
  // (DiveHighlightMark) precisely so it can be found this way — text
  // content alone isn't a stable enough selector once multiple highlights
  // share overlapping words.
  useEffect(() => {
    if (!scrolledToDiveHighlightId) return;
    if (!panelHighlights.some((highlight) => highlight.id === scrolledToDiveHighlightId)) return;
    const mark = dialogueRef.current?.querySelector(`[data-dive-highlight-id="${scrolledToDiveHighlightId}"]`);
    mark?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrolledToDiveHighlightId, panelHighlights]);

  const send = async (content: string) => {
    if (!content.trim() || pending) return;
    setPending(true);
    setStreamingReply("");
    await onSendMessage(panel.id, content, (chunk) => setStreamingReply((prev) => prev + chunk));
    setStreamingReply("");
    setPending(false);
  };

  // A reply is in flight whenever the newest turn is the reader's own —
  // true for follow-ups sent from this pane's composer (which also flips
  // `pending`), but also for a freshly opened dive, whose first message is
  // sent by the caller before this component ever mounts, so `pending`
  // alone would miss it.
  const lastTurn = panel.turns[panel.turns.length - 1];
  const awaitingReply = pending || lastTurn?.role === "user";

  return (
    <div className="dive-panel-pane">
      <header className="dive-panel-header">{panel.label}</header>
      <div className="dive-panel-dialogue" ref={dialogueRef}>
        {panel.turns.map((turn, index) => (
          <div key={index} className={`dive-turn dive-turn-${turn.role}`}>
            {renderTurnContent(turn.content, markdownComponents)}
          </div>
        ))}
        {awaitingReply ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply ? renderTurnContent(streamingReply, markdownComponents) : <ThinkingIndicator />}
          </div>
        ) : null}
      </div>
      {captured ? (
        <DiveSelectionTip
          selectionText={captured.text}
          position={captured.position}
          onAddHighlight={(text, comment, style) => {
            onAddHighlight(panel.id, text, comment, style);
            clear();
          }}
          onDiveDeeper={() => {
            onNestedDive({ parentId: panel.id, selection: captured.text, contextText: captured.context });
            clear();
          }}
          onPin={() => onPin(captured.text, captured.context)}
          onClose={clear}
        />
      ) : null}
      {editingHighlight && editingHighlightObj ? (
        <DiveHighlightEditTip
          highlight={editingHighlightObj}
          position={editingHighlight.position}
          onEdit={(edit) => onEditHighlight(editingHighlightObj.id, edit)}
          onDelete={() => {
            onDeleteHighlight(editingHighlightObj.id);
            setEditingHighlight(null);
          }}
          onOpenDive={onOpenDive}
          onStartDive={() => {
            onDiveFromHighlight(editingHighlightObj, contextForHighlight(panel, editingHighlightObj));
            setEditingHighlight(null);
          }}
          onClose={() => setEditingHighlight(null)}
        />
      ) : null}
      <form
        className="dive-panel-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = draft.trim();
          if (!content) return;
          setDraft("");
          void send(content);
        }}
      >
        <textarea
          value={draft}
          placeholder="Ask a follow-up…"
          rows={2}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
