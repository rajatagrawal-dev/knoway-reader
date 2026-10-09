import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import type { DiveHighlight, DiveHighlightPlacement, DivePanel } from "./types";
import { childrenOf, rootPanelOf } from "./tree";
import { useSelectionCapture } from "./useSelectionCapture";
import type { AnchorRect } from "./useFlippedPlacement";
import DiveSelectionTip from "./DiveSelectionTip";
import DiveHighlightMark from "./DiveHighlightMark";
import DiveHighlightEditTip from "./DiveHighlightEditTip";
import { normalizeMathNotation } from "./mathNotation";
import { rehypeEquationBlocks } from "./rehypeEquationBlocks";
import { openingMessage } from "./prompts";
import { rehypeAnnotate, type AnnotateOptions, type AnnotationTarget } from "./annotate";
import {
  answerGrounding,
  chipLabel,
  citedSources,
  decodeChipTarget,
  parseAnswer,
  toChipMarkdown,
  trimPartialMarker,
} from "../grounding/citations";
import CitationChip, { type ResolvedRef } from "../grounding/CitationChip";
import { AnswerBadge, SourcesFooter } from "../grounding/AnswerParts";
import type { SourceRef } from "../grounding/types";
import type { Attachment } from "../grounding/attachments";
import AttachmentChips from "../grounding/AttachmentChips";
import QuestionComposer from "../grounding/QuestionComposer";
import { Check, CornerDownRight, GitBranch, Network, Workflow } from "lucide-react";
import { useExperiments } from "./experiments";
import { hideSuggestionBlock, type DiveSuggestion } from "./suggestions";
import { splitDiagram } from "./diagram";
import MermaidDiagram from "./MermaidDiagram";

// Sent by "More detail": a follow-up that reuses the last answer's sources.
export const MORE_DETAIL_MESSAGE = "More detail, please.";
// Sent by "Diagram" (the diagrams experiment).
export const DIAGRAM_MESSAGE = "Show this as a diagram.";

export interface SendOptions {
  reuseSources?: boolean; // answer from the previous answer's sources, without choosing new ones
  onSources?: (sources: SourceRef[]) => void; // the sources, once chosen — before the reply streams in
  attachments?: Attachment[]; // text the reader added to this question
  diagram?: boolean; // asks for a diagram (the diagrams experiment)
}

export interface DivePanelPaneProps {
  panel: DivePanel;
  allPanels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  // The dive currently open (focused). Clicking dived-into text whose dive
  // isn't this one opens it; clicking it again once it is shows its tooltip.
  focusedPanelId: string;
  onOpenDive: (panelId: string) => void;
  onSendMessage: (
    panelId: string,
    content: string,
    onChunk?: (chunk: string) => void,
    options?: SendOptions,
  ) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string } & DiveHighlightPlacement) => void;
  // A suggested dive's pill (the suggestions experiment).
  onSuggestedDive: (request: { parentId: string; turnIndex: number; suggestion: DiveSuggestion }) => void;
  pageLabel: (pageNumber: number) => string;
  onJumpToSource: (ref: ResolvedRef) => void;
  // Text added to this dive's next question ("Add to question").
  attachments: Attachment[];
  onAddToQuestion: (kind: Attachment["kind"], text: string, pageNumber?: number) => void;
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
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
  // For citation chips: each turn's sources (the streaming reply's too).
  sourcesForTurn: (turnIndex: number) => SourceRef[] | undefined;
  pageLabel: (pageNumber: number) => string;
  onJumpToSource: (ref: ResolvedRef) => void;
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
      // Citation chips arrive as empty `#cite:` links (see toChipMarkdown);
      // any other link is an ordinary one, opened outside the app.
      a: ({ href, title, children }) => {
        const target = href ? decodeChipTarget(href) : null;
        if (!target) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        const handlers = handlersRef.current!;
        const byLabel = new Map((handlers.sourcesForTurn(target.turnIndex) ?? []).map((source) => [source.label, source]));
        const refs = target.refs.flatMap(({ label, start, end }): ResolvedRef[] => {
          const source = byLabel.get(label);
          return source ? [{ source, range: [start, end] }] : [];
        });
        return (
          <CitationChip
            kind={target.kind}
            quoteMissing={target.quoteMissing}
            label={title ?? chipLabel(target.kind, refs.map((ref) => handlers.pageLabel(ref.source.pageNumber)))}
            refs={refs}
            pageLabel={(pageNumber) => handlersRef.current!.pageLabel(pageNumber)}
            onJump={(ref) => handlersRef.current!.onJumpToSource(ref)}
          />
        );
      },
    }),
    [handlersRef],
  );
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
  sources,
  pageLabel,
  streaming = false,
}: {
  content: string;
  turnIndex: number;
  annotate: Omit<AnnotateOptions, "turnIndex">;
  components: Components;
  promoteMath?: boolean;
  // A grounded answer's sources: its [S1]-style markers become chips.
  sources?: SourceRef[];
  pageLabel?: (pageNumber: number) => string;
  streaming?: boolean;
}) {
  const rehypePlugins: MarkdownOptions["rehypePlugins"] = [
    [rehypeKatex, KATEX_OPTIONS],
    rehypeEquationBlocks,
    [rehypeAnnotate, { ...annotate, turnIndex }],
  ];
  return (
    <div className="dive-turn-body" data-turn-index={turnIndex}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={rehypePlugins} components={components}>
        {renderedMarkdown(content, { promoteMath, sources, pageLabel, streaming, turnIndex })}
      </ReactMarkdown>
    </div>
  );
}

function renderedMarkdown(
  content: string,
  options: {
    promoteMath: boolean;
    sources?: SourceRef[];
    pageLabel?: (pageNumber: number) => string;
    streaming: boolean;
    turnIndex: number;
  },
): string {
  // An answer's <next> block (suggested dives) is never text: it's
  // stripped from a finished answer, and hidden while one streams in.
  const visible = options.promoteMath ? hideSuggestionBlock(content, options.streaming) : content;
  const text = options.streaming ? trimPartialMarker(visible) : visible;
  const markdown = normalizeMathNotation(text, { promote: options.promoteMath });
  if (!options.sources || !options.pageLabel) return markdown;
  return toChipMarkdown(markdown, options.sources, options.turnIndex, options.pageLabel);
}

// An answer's diagram, drawn apart from its text (diagram.ts).
const diagramOf = splitDiagram;

// A grounded answer, not an error notice: gets a badge and a sources line.
function isGroundedAnswer(turn: DivePanel["turns"][number]): turn is DivePanel["turns"][number] & { sources: SourceRef[] } {
  return (
    turn.role === "assistant" && Array.isArray(turn.sources) && Boolean(turn.content.trim()) && !turn.content.startsWith("⚠️")
  );
}

// Replies saved empty (a model that ran out of tokens before answering, before
// that was caught) read as a notice rather than a blank space.
const EMPTY_REPLY_NOTICE = "⚠️ No answer came back for this. Ask again below.";

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

// Where to go next after an answer (the suggestions experiment): questions
// continue in this dive, concepts open a nested one. One already explored
// is checked, and opens what was explored.
function SuggestionPills({
  suggestions,
  explored,
  disabled,
  onPick,
}: {
  suggestions: DiveSuggestion[];
  explored: (suggestion: DiveSuggestion) => boolean;
  disabled: boolean;
  onPick: (suggestion: DiveSuggestion) => void;
}) {
  return (
    <div className="dive-suggestions" role="group" aria-label="Suggested next steps">
      {suggestions.map((suggestion, index) => {
        const done = explored(suggestion);
        const Icon = suggestion.kind === "dive" ? GitBranch : suggestion.kind === "diagram" ? Workflow : CornerDownRight;
        const title =
          suggestion.kind === "dive"
            ? done
              ? "Open the dive on this"
              : "Dive into this"
            : suggestion.kind === "diagram"
              ? "Show as a diagram"
              : "Ask this";
        return (
          <button
            key={`${suggestion.kind}-${index}`}
            type="button"
            className={`dive-suggestion dive-suggestion--${suggestion.kind}${done ? " explored" : ""}`}
            title={title}
            disabled={disabled && !(done && suggestion.kind === "dive")}
            onClick={() => onPick(suggestion)}
          >
            {done ? <Check width={12} height={12} aria-hidden="true" /> : <Icon width={12} height={12} aria-hidden="true" />}
            <span>{suggestion.text}</span>
          </button>
        );
      })}
    </div>
  );
}

// A nested dive's reminder of where its tree started (the rootAnchor
// experiment): the passage, its page, and a way back to its dive.
function RootAnchorCard({
  root,
  pageLabel,
  onOpen,
}: {
  root: DivePanel;
  pageLabel: (pageNumber: number) => string;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const text = root.selection || "A selected region of the page";
  const clipped = !open && text.length > 160 ? `${text.slice(0, 160)}…` : text;
  return (
    <div className="dive-root-anchor">
      <div className="dive-root-anchor-head">
        <span className="dive-root-anchor-label">
          <Network width={12} height={12} aria-hidden="true" /> Started from
          {root.pageNumber !== undefined ? ` p. ${pageLabel(root.pageNumber)}` : ""}
        </span>
        <button type="button" className="dive-root-anchor-open" onClick={onOpen}>
          Back to it
        </button>
      </div>
      <button type="button" className="dive-root-anchor-text" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {clipped}
      </button>
    </div>
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
  onSuggestedDive,
  pageLabel,
  onJumpToSource,
  attachments,
  onAddToQuestion,
  onRemoveAttachment,
  onClearAttachments,
  onAddHighlight,
  onEditHighlight,
  onDeleteHighlight,
  onDiveFromHighlight,
  onPin,
}: DivePanelPaneProps) {
  const experiments = useExperiments();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const [streamingSources, setStreamingSources] = useState<SourceRef[] | undefined>(undefined);
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
    sourcesForTurn: (turnIndex) =>
      turnIndex === panel.turns.length ? streamingSources : panel.turns[turnIndex]?.sources,
    pageLabel,
    onJumpToSource,
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

  const send = async (content: string, options: Pick<SendOptions, "reuseSources" | "diagram"> = {}) => {
    if (!content.trim() || pending) return;
    setPending(true);
    setStreamingReply("");
    setStreamingSources(undefined);
    // "More detail" is about the last answer; what's attached waits for the
    // reader's own next question.
    const attached = options.reuseSources || options.diagram ? [] : attachments;
    if (attached.length) onClearAttachments();
    await onSendMessage(panel.id, content, (chunk) => setStreamingReply((prev) => prev + chunk), {
      ...options,
      attachments: attached,
      onSources: setStreamingSources,
    });
    setStreamingReply("");
    setStreamingSources(undefined);
    setPending(false);
  };

  // A reply is in flight whenever the newest turn is the reader's own —
  // true for follow-ups sent from this pane's composer (which also flips
  // `pending`), but also for a freshly opened dive, whose first message is
  // sent by the caller before this component ever mounts, so `pending`
  // alone would miss it.
  const lastTurn = panel.turns[panel.turns.length - 1];
  const awaitingReply = pending || lastTurn?.role === "user";

  const root = experiments.rootAnchor && panel.parentId ? rootPanelOf(allPanels, panel.id) : null;
  const askedLater = (turnIndex: number, text: string) =>
    panel.turns.slice(turnIndex + 1).some((turn) => turn.role === "user" && turn.content.trim().toLowerCase() === text.trim().toLowerCase());
  const explored = (turnIndex: number) => (suggestion: DiveSuggestion) =>
    suggestion.kind === "dive"
      ? children.some((child) => child.selection.trim().toLowerCase() === suggestion.text.trim().toLowerCase())
      : suggestion.kind === "ask"
        ? askedLater(turnIndex, suggestion.text)
        : false;
  const pickSuggestion = (turnIndex: number) => (suggestion: DiveSuggestion) => {
    if (suggestion.kind === "dive") onSuggestedDive({ parentId: panel.id, turnIndex, suggestion });
    else if (suggestion.kind === "diagram") void send(DIAGRAM_MESSAGE, { diagram: true });
    else void send(suggestion.text);
  };

  return (
    <div className="dive-panel-pane">
      <header className="dive-panel-header">{panel.label}</header>
      <div className="dive-panel-dialogue" ref={dialogueRef}>
        {root && root.id !== panel.id ? (
          <RootAnchorCard root={root} pageLabel={pageLabel} onOpen={() => onOpenDive(root.id)} />
        ) : null}
        {panel.turns.map((turn, index) =>
          isOpeningTurn(panel, index) ? (
            <SourceExcerpt key={index} panel={panel} annotate={annotate} components={markdownComponents} />
          ) : (
            <div key={index} className={`dive-turn dive-turn-${turn.role}`}>
              {isGroundedAnswer(turn) ? (
                <AnswerBadge grounding={answerGrounding(parseAnswer(turn.content, turn.sources))} />
              ) : null}
              {turn.role === "assistant" && diagramOf(turn.content).code ? (
                <MermaidDiagram code={diagramOf(turn.content).code!} />
              ) : null}
              <TurnMarkdown
                content={
                  turn.role === "assistant" && !turn.content.trim()
                    ? EMPTY_REPLY_NOTICE
                    : turn.role === "assistant"
                      ? diagramOf(turn.content).text
                      : turn.content
                }
                turnIndex={index}
                annotate={annotate}
                components={markdownComponents}
                promoteMath={turn.role === "assistant"}
                sources={turn.role === "assistant" ? turn.sources : undefined}
                pageLabel={pageLabel}
              />
              {turn.role === "user" && turn.attachments?.length ? (
                <AttachmentChips attachments={turn.attachments} pageLabel={pageLabel} />
              ) : null}
              {isGroundedAnswer(turn) ? (
                <div className="answer-footer">
                  <SourcesFooter
                    sent={turn.sources}
                    cited={citedSources(turn.content, turn.sources)}
                    pageLabel={pageLabel}
                    onJump={onJumpToSource}
                  />
                  {index === panel.turns.length - 1 && !awaitingReply ? (
                    <button
                      type="button"
                      className="answer-more"
                      onClick={() => void send(MORE_DETAIL_MESSAGE, { reuseSources: true })}
                    >
                      More detail
                    </button>
                  ) : null}
                  {experiments.diagrams && index === panel.turns.length - 1 && !awaitingReply && !diagramOf(turn.content).code ? (
                    <button type="button" className="answer-more" onClick={() => void send(DIAGRAM_MESSAGE, { diagram: true })}>
                      Diagram
                    </button>
                  ) : null}
                </div>
              ) : null}
              {experiments.suggestions && turn.role === "assistant" && turn.suggestions?.length ? (
                <SuggestionPills
                  suggestions={experiments.diagrams ? turn.suggestions : turn.suggestions.filter((s) => s.kind !== "diagram")}
                  explored={explored(index)}
                  disabled={awaitingReply}
                  onPick={pickSuggestion(index)}
                />
              ) : null}
            </div>
          ),
        )}
        {awaitingReply ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply && diagramOf(hideSuggestionBlock(streamingReply)).pending ? (
              <span className="dive-thinking">Drawing the diagram…</span>
            ) : null}
            {streamingReply ? (
              <TurnMarkdown
                content={diagramOf(streamingReply).text}
                turnIndex={panel.turns.length}
                annotate={annotate}
                components={markdownComponents}
                sources={streamingSources}
                pageLabel={pageLabel}
                streaming
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
          onAddToQuestion={() => {
            // The quoted passage a root dive opens with is the document's
            // own text; everything else here is an answer.
            if (captured.turnIndex === 0 && !panel.parentId && panel.pageNumber !== undefined) {
              onAddToQuestion("document", captured.text, panel.pageNumber);
            } else {
              onAddToQuestion("answer", captured.text);
            }
            clear();
            composerRef.current?.focus();
          }}
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
      <QuestionComposer
        className="dive-panel-composer"
        value={draft}
        onChange={setDraft}
        onSubmit={() => {
          const content = draft.trim();
          setDraft("");
          void send(content);
        }}
        placeholder="Ask a follow-up…"
        busy={pending}
        submitLabel="Send"
        busyLabel="Sending…"
        attachments={attachments}
        pageLabel={pageLabel}
        onRemoveAttachment={onRemoveAttachment}
        textareaRef={composerRef}
      />
    </div>
  );
}
