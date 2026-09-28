import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { Element, ElementContent, Root } from "hast";
import type { DiveHighlight, DiveHighlightPlacement, DivePanel } from "./types";
import { childrenOf } from "./tree";
import { useSelectionCapture } from "./useSelectionCapture";
import type { AnchorRect } from "./useFlippedPlacement";
import DiveSelectionTip from "./DiveSelectionTip";
import DiveHighlightMark from "./DiveHighlightMark";
import DiveHighlightEditTip from "./DiveHighlightEditTip";
import { normalizeMathNotation } from "./mathNotation";
import { openingMessage } from "./prompts";
import { rehypeAnnotate, type AnnotateOptions, type AnnotationTarget } from "./annotate";

export interface DivePanelPaneProps {
  panel: DivePanel;
  allPanels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  // The dive currently open (focused). Clicking dived-into text whose dive
  // isn't this one opens it; clicking it again once it is shows its tooltip.
  focusedPanelId: string;
  onOpenDive: (panelId: string) => void;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string } & DiveHighlightPlacement) => void;
  onAddHighlight: (
    panelId: string,
    text: string,
    comment: string,
    style?: Pick<DiveHighlight, "highlightColor" | "highlightStyle" | "divePanelId"> & DiveHighlightPlacement,
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

// Wraps text that seeded a nested dive, opening it on click. Deliberately a
// <span role="button"> rather than a real <button>: browsers treat a
// <button>'s content as an activatable control rather than selectable text
// — starting or dragging a selection into one is silently ignored — which
// meant a highlight could never be placed on (or made to overlap) marked
// text in the first place, no matter how the marker/highlight overlap
// below is resolved. DiveHighlightMark already sidesteps this the same way
// by using <mark>, not <button>, for the same reason.
function DiveMarkerSpan({ onActivate, children }: { onActivate: (anchorRect: DOMRect) => void; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      className="dive-turn-marker"
      onClick={(event) => {
        event.stopPropagation();
        onActivate(event.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onActivate(event.currentTarget.getBoundingClientRect());
        }
      }}
    >
      {children}
    </span>
  );
}

// Mirrors useSelectionCapture's own context extraction (nearest container's
// text, truncated) for the case where there's no live browser selection to
// read from — diving from an already-placed highlight instead of a fresh
// one — by finding the turn the highlight's text lives in and using that.
function contextForText(panel: DivePanel, text: string): string {
  const turn = panel.turns.find((t) => t.content.includes(text));
  return (turn?.content ?? text).slice(0, HIGHLIGHT_DIVE_CONTEXT_LENGTH);
}

function contextForHighlight(panel: DivePanel, highlight: DiveHighlight): string {
  return contextForText(panel, highlight.text);
}

// Everything the `mark` component below needs to turn one of annotate.ts's
// marks into a live highlight or dive marker.
interface AnnotationHandlers {
  highlightsById: Map<string, DiveHighlight>;
  scrolledToDiveHighlightId: string | null;
  editingHighlightId: string | null;
  onMarkerClick: (panelId: string, anchorRect: DOMRect) => void;
  onHighlightClick: (highlight: DiveHighlight, anchorRect: DOMRect) => void;
}

// `components` is passed to every ReactMarkdown instance in this panel and
// must stay referentially stable across renders — react-markdown's custom
// component functions are compared by reference, so a fresh object here
// makes React treat each <mark> as a brand-new component type and remount
// its DOM, silently clearing any browser text selection the user just made
// inside it. Everything that changes is read through `handlersRef` instead,
// live on every render.
function useAnnotationComponents(handlersRef: RefObject<AnnotationHandlers>): Components {
  return useMemo<Components>(
    () => ({
      mark: ({ node, children }) => {
        const kind = node?.properties.dataDiveKind;
        const id = String(node?.properties.dataDiveId ?? "");
        const handlers = handlersRef.current!;
        if (kind === "highlight") {
          const highlight = handlers.highlightsById.get(id);
          if (highlight) {
            return (
              <DiveHighlightMark
                highlight={highlight}
                isScrolledTo={handlers.scrolledToDiveHighlightId === id}
                isEditing={handlers.editingHighlightId === id}
                onClick={handlers.onHighlightClick}
              >
                {children}
              </DiveHighlightMark>
            );
          }
        }
        if (kind === "marker") {
          return <DiveMarkerSpan onActivate={(anchorRect) => handlers.onMarkerClick(id, anchorRect)}>{children}</DiveMarkerSpan>;
        }
        return <mark>{children}</mark>;
      },
    }),
    [handlersRef],
  );
}

// rehype-katex replaces a fenced $$ block with a bare <span
// class="katex-display"> sitting directly between paragraphs. Wrapping each
// one in a <div class="dive-equation"> gives it a block to style. A
// paragraph that's just one inline equation (the model wrote a standalone
// equation as $...$ rather than $$...$$) gets the same centered look via
// dive-equation-line.
function rehypeEquationBlocks() {
  const hasClass = (node: ElementContent, name: string): boolean =>
    node.type === "element" &&
    Array.isArray(node.properties.className) &&
    node.properties.className.includes(name);
  const visit = (parent: Root | Element) => {
    parent.children = parent.children.map((child) => {
      if (child.type !== "element") return child;
      if (hasClass(child, "katex-display")) {
        return { type: "element", tagName: "div", properties: { className: ["dive-equation"] }, children: [child] };
      }
      if (child.tagName === "p") {
        const content = child.children.filter((c) => !(c.type === "text" && c.value.trim() === ""));
        if (content.length === 1 && hasClass(content[0], "katex")) {
          child.properties.className = ["dive-equation-line"];
        }
      }
      visit(child);
      return child;
    }) as typeof parent.children;
  };
  return (tree: Root) => visit(tree);
}

const KATEX_OPTIONS = { throwOnError: false, strict: false };

// One turn's markdown. The wrapper's data-turn-index is how a selection
// knows which turn it was made in (see useSelectionCapture), and the same
// index tells rehypeAnnotate which highlights belong here — so the wrapper
// must hold exactly the rendered markdown and nothing else, or the text a
// selection's position is counted against wouldn't match what's annotated.
function TurnMarkdown({
  content,
  turnIndex,
  annotate,
  components,
  promoteMath = true,
}: {
  content: string;
  turnIndex: number;
  annotate: Omit<AnnotateOptions, "turnIndex">;
  components: Components;
  promoteMath?: boolean;
}) {
  const rehypePlugins: MarkdownOptions["rehypePlugins"] = [
    [rehypeKatex, KATEX_OPTIONS],
    rehypeEquationBlocks,
    [rehypeAnnotate, { ...annotate, turnIndex }],
  ];
  return (
    <div className="dive-turn-body" data-turn-index={turnIndex}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins} components={components}>
        {normalizeMathNotation(content, { promote: promoteMath })}
      </ReactMarkdown>
    </div>
  );
}

// The dive's opening message is always the canned openingMessage(), which
// just restates the selection — rendered as a chat bubble it reads as noise
// and pushes the actual explanation down. Shown instead as a quiet excerpt
// of the passage being explained (or the selected region's image), the way a
// textbook sets off the text under discussion. Keeps the .dive-turn class so
// text in it stays selectable/highlightable like any other turn.
function isOpeningTurn(panel: DivePanel, index: number): boolean {
  const turn = panel.turns[index];
  return index === 0 && turn.role === "user" && turn.content === openingMessage(panel.selection);
}

function SourceExcerpt({
  panel,
  annotate,
  components,
}: {
  panel: DivePanel;
  annotate: Omit<AnnotateOptions, "turnIndex">;
  components: Components;
}) {
  const image = panel.selectionImage;
  return (
    <figure className="dive-turn dive-source">
      <figcaption className="dive-source-label">{panel.parentId ? "Diving deeper into" : "From the text"}</figcaption>
      {image ? (
        <img className="dive-source-image" src={`data:${image.mediaType};base64,${image.data}`} alt="Selected region" />
      ) : null}
      {panel.selection ? (
        <blockquote className="dive-source-quote">
          <TurnMarkdown
            content={panel.selection}
            turnIndex={0}
            annotate={annotate}
            components={components}
            promoteMath={false}
          />
        </blockquote>
      ) : null}
    </figure>
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
  focusedPanelId,
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
    anchorRect: AnchorRect;
  } | null>(null);
  // Tooltip for a dive marker — dived-into text with no highlight of its
  // own — opened by clicking it while its dive is already open.
  const [markerTip, setMarkerTip] = useState<{
    panelId: string;
    text: string;
    anchorRect: AnchorRect;
  } | null>(null);
  const dialogueRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // One line tall by default, growing with Shift+Enter lines (up to the CSS
  // max-height, then scrolling) and shrinking back once the draft is sent.
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "auto";
    composer.style.height = `${composer.scrollHeight + composer.offsetHeight - composer.clientHeight}px`;
  }, [draft]);
  const { captured, clear } = useSelectionCapture(dialogueRef, "[data-turn-index]");
  const children = useMemo(() => childrenOf(allPanels, panel.id), [allPanels, panel.id]);
  const allPanelsRef = useRef(allPanels);
  allPanelsRef.current = allPanels;
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

  // Read through a ref so the click handlers below stay referentially
  // stable — they feed the memoized markdown components, and a new identity
  // there remounts the dialogue's DOM (see useMarkdownComponents).
  const focusedPanelIdRef = useRef(focusedPanelId);
  focusedPanelIdRef.current = focusedPanelId;

  const handleHighlightClick = useCallback(
    (highlight: DiveHighlight, anchorRect: DOMRect) => {
      if (highlight.divePanelId && highlight.divePanelId !== focusedPanelIdRef.current) {
        onOpenDive(highlight.divePanelId);
        return;
      }
      setEditingHighlight({
        highlightId: highlight.id,
        anchorRect: { left: anchorRect.left, top: anchorRect.top, bottom: anchorRect.bottom },
      });
    },
    [onOpenDive],
  );

  const handleMarkerClick = useCallback(
    (panelId: string, anchorRect: DOMRect) => {
      if (panelId !== focusedPanelIdRef.current) {
        onOpenDive(panelId);
        return;
      }
      const text = allPanelsRef.current.find((p) => p.id === panelId)?.selection ?? "";
      setMarkerTip({ panelId, text, anchorRect: { left: anchorRect.left, top: anchorRect.top, bottom: anchorRect.bottom } });
    },
    [onOpenDive],
  );

  const highlightsById = useMemo(
    () => new Map(panelHighlights.map((highlight) => [highlight.id, highlight])),
    [panelHighlights],
  );
  const annotationHandlersRef = useRef<AnnotationHandlers | null>(null);
  annotationHandlersRef.current = {
    highlightsById,
    scrolledToDiveHighlightId,
    editingHighlightId: editingHighlight?.highlightId ?? null,
    onMarkerClick: handleMarkerClick,
    onHighlightClick: handleHighlightClick,
  };
  const markdownComponents = useAnnotationComponents(annotationHandlersRef);

  // Every nested dive started from here also gets a DiveHighlight carrying
  // its divePanelId, which already marks (and opens) the dived-into text —
  // a plain marker is only needed for a dive without one.
  const annotationTargets = useMemo<AnnotationTarget[]>(() => {
    const divedFromHighlight = new Set(panelHighlights.map((highlight) => highlight.divePanelId));
    return [
      ...panelHighlights.map((highlight) => ({
        kind: "highlight" as const,
        id: highlight.id,
        text: highlight.text,
        turnIndex: highlight.turnIndex,
        occurrence: highlight.occurrence,
      })),
      ...children
        .filter((child) => child.selection && !divedFromHighlight.has(child.id))
        .map((child) => ({ kind: "marker" as const, id: child.id, text: child.selection })),
    ];
  }, [panelHighlights, children]);
  // Fresh on every render and filled in turn order as the turns below
  // render — see AnnotateOptions.claims.
  const annotate = { targets: annotationTargets, claims: new Map<string, number>() };

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
        {panel.turns.map((turn, index) =>
          isOpeningTurn(panel, index) ? (
            <SourceExcerpt key={index} panel={panel} annotate={annotate} components={markdownComponents} />
          ) : (
            <div key={index} className={`dive-turn dive-turn-${turn.role}`}>
              <TurnMarkdown
                content={turn.content}
                turnIndex={index}
                annotate={annotate}
                components={markdownComponents}
                promoteMath={turn.role === "assistant"}
              />
            </div>
          ),
        )}
        {awaitingReply ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply ? (
              <TurnMarkdown
                content={streamingReply}
                turnIndex={panel.turns.length}
                annotate={annotate}
                components={markdownComponents}
              />
            ) : (
              <span className="dive-thinking">
                <ThinkingIndicator />
              </span>
            )}
          </div>
        ) : null}
      </div>
      {captured ? (
        <DiveSelectionTip
          selectionText={captured.text}
          anchorRect={captured.anchorRect}
          onAddHighlight={(text, comment, style) => {
            onAddHighlight(panel.id, text, comment, {
              ...style,
              turnIndex: captured.turnIndex,
              occurrence: captured.occurrence,
            });
            clear();
          }}
          onDiveDeeper={() => {
            onNestedDive({
              parentId: panel.id,
              selection: captured.text,
              contextText: captured.context,
              turnIndex: captured.turnIndex,
              occurrence: captured.occurrence,
            });
            clear();
          }}
          onPin={() => onPin(captured.text, captured.context)}
          onClose={clear}
        />
      ) : null}
      {markerTip ? (
        <DiveSelectionTip
          selectionText={markerTip.text}
          anchorRect={markerTip.anchorRect}
          onAddHighlight={(text, comment, style) =>
            onAddHighlight(panel.id, text, comment, { ...style, divePanelId: markerTip.panelId })
          }
          divePanelId={markerTip.panelId}
          onOpenDive={onOpenDive}
          onDiveDeeper={() => onOpenDive(markerTip.panelId)}
          onPin={() => onPin(markerTip.text, contextForText(panel, markerTip.text))}
          onClose={() => setMarkerTip(null)}
        />
      ) : null}
      {editingHighlight && editingHighlightObj ? (
        <DiveHighlightEditTip
          highlight={editingHighlightObj}
          anchorRect={editingHighlight.anchorRect}
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
          ref={composerRef}
          value={draft}
          placeholder="Ask a follow-up…"
          rows={1}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter adds a line. Not while an IME is
            // composing, where Enter confirms the composed text instead.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
