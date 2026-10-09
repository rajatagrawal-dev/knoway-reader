import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Pencil, SquarePen, Trash2 } from "lucide-react";
import { formatPageLabel } from "../pageLabels";
import { answerGrounding, citedSources, parseAnswer } from "../grounding/citations";
import AnswerMarkdown from "../grounding/AnswerMarkdown";
import { AnswerBadge, SourcesFooter } from "../grounding/AnswerParts";
import { scopeLabel, type AskBasis, type AskScope } from "../grounding/ask";
import type { ResolvedRef } from "../grounding/CitationChip";
import type { Attachment } from "../grounding/attachments";
import AttachmentChips from "../grounding/AttachmentChips";
import QuestionComposer from "../grounding/QuestionComposer";
import FloatingTip from "../components/FloatingTip";
import HighlightToolbar from "../components/HighlightToolbar";
import type { AnchorRect } from "../deepdive/useFlippedPlacement";
import { ask, MORE_DETAIL_QUESTION, newThread, type AskContext } from "./job";
import { useAskThreads, type AskStore } from "./store";
import type { AskThread, AskTurn } from "./types";

interface AskPanelProps {
  store: AskStore;
  getContext: () => AskContext | null;
  hasDocument: boolean;
  pageLabels: string[] | null;
  // The open thread lives in App, so it's still open after switching panels.
  openThreadId: string | null;
  onOpenThread: (threadId: string | null) => void;
  onJumpToSource: (ref: ResolvedRef) => void;
  focusRequest: number; // bumped by ⌘J
  // Text added to the next question ("Add to question").
  attachments: Attachment[];
  onAddToQuestion: (kind: Attachment["kind"], text: string) => void;
  onRemoveAttachment: (id: string) => void;
  onClearAttachments: () => void;
  onPin: (text: string, context: string) => void;
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

// "Based on…" under an answer, naming the part of the document it was about
// when the question narrowed it down ("this chapter", "page 42").
function basisText(basis: AskBasis | undefined, scope: AskScope | undefined, pageLabel: (n: number) => string) {
  if (!basis) return undefined;
  const where = scope && scope.kind !== "document" ? scopeLabel(scope, pageLabel) : null;
  if (basis.kind === "scope") return where ? `Based on all of ${where}` : "Based on the whole document";
  if (basis.kind === "partial") return `Based on the most relevant part of ${where ?? "the document"}`;
  if (basis.kind === "passages" && where) {
    return `Based on ${basis.count} passage${basis.count === 1 ? "" : "s"} from ${where}`;
  }
  return undefined;
}

export default function AskPanel({
  store,
  getContext,
  hasDocument,
  pageLabels,
  openThreadId,
  onOpenThread,
  onJumpToSource,
  focusRequest,
  attachments,
  onAddToQuestion,
  onRemoveAttachment,
  onClearAttachments,
  onPin,
}: AskPanelProps) {
  const threads = useAskThreads(store);
  const thread = openThreadId ? threads.find((t) => t.id === openThreadId) : undefined;
  const pageLabel = useMemo(() => (n: number) => formatPageLabel(pageLabels, n), [pageLabels]);
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusRequest) composerRef.current?.focus();
  }, [focusRequest]);

  const busy = Boolean(thread?.turns.some((turn) => turn.status === "streaming"));
  const lastTurn = thread?.turns[thread.turns.length - 1];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [thread?.id, thread?.turns.length, lastTurn?.content]);

  const run = (threadId: string, question: string, opts?: Parameters<typeof ask>[4]) => {
    const context = getContext();
    if (!context) return;
    void ask(store, threadId, question, context, opts);
  };

  const submit = () => {
    const question = draft.trim();
    if (!question || busy || !getContext()) return;
    setDraft("");
    const attached = attachments;
    if (attached.length) onClearAttachments();
    if (thread) {
      run(thread.id, question, { attachments: attached });
    } else {
      const created = newThread(question);
      store.add(created);
      onOpenThread(created.id);
      run(created.id, question, { attachments: attached });
    }
  };

  // Selecting text in an answer brings up the same toolbar as in a dive
  // (copy, pin, add to question).
  const [selection, setSelection] = useState<{ text: string; context: string; anchorRect: AnchorRect } | null>(null);
  const captureSelection = () => {
    const current = window.getSelection();
    const text = current?.toString().trim() ?? "";
    const node = current?.anchorNode;
    const answer = node && (node instanceof Element ? node : node.parentElement)?.closest(".ask-turn-assistant");
    if (!text || !answer || !current?.rangeCount) {
      setSelection(null);
      return;
    }
    const rect = current.getRangeAt(0).getBoundingClientRect();
    setSelection({
      text,
      context: answer.textContent ?? text,
      anchorRect: { left: rect.left, top: rect.top, bottom: rect.bottom },
    });
  };
  const closeSelection = useCallback(() => setSelection(null), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  return (
    <>
      <header className="sidebar-header ask-header">
        <h2 title={thread?.title}>{thread ? thread.title : "Ask"}</h2>
        <div className="ask-header-actions">
          <button
            type="button"
            className={`ask-icon-button${historyOpen ? " is-active" : ""}`}
            onClick={() => setHistoryOpen((open) => !open)}
            title="Earlier questions"
            aria-expanded={historyOpen}
            disabled={threads.length === 0}
          >
            <History width={16} height={16} />
          </button>
          <button
            type="button"
            className="ask-icon-button"
            onClick={() => {
              onOpenThread(null);
              setHistoryOpen(false);
              composerRef.current?.focus();
            }}
            title="New question"
            disabled={!thread}
          >
            <SquarePen width={16} height={16} />
          </button>
        </div>
        {historyOpen ? (
          <HistoryMenu
            store={store}
            threads={threads}
            openThreadId={openThreadId}
            onOpen={(threadId) => {
              onOpenThread(threadId);
              setHistoryOpen(false);
            }}
            onClose={closeHistory}
          />
        ) : null}
      </header>

      <div className="sidebar-list ask-body" onMouseUp={captureSelection}>
        {thread ? (
          <div className="ask-thread">
            {thread.turns.map((turn, index) => (
              <TurnView
                key={index}
                turn={turn}
                isLast={index === thread.turns.length - 1}
                pageLabel={pageLabel}
                onJump={onJumpToSource}
                onMoreDetail={() => run(thread.id, MORE_DETAIL_QUESTION, { reuseSources: true })}
                onWider={() => run(thread.id, "", { retry: { wider: true } })}
                onGeneral={() => run(thread.id, "", { retry: { generalAllowed: true } })}
              />
            ))}
            <div ref={endRef} />
          </div>
        ) : (
          <div className="ask-empty">
            <p>Ask anything about this document.</p>
            <p className="ask-empty-hint">Mention “this page” or “chapter 3” to narrow it down.</p>
          </div>
        )}
      </div>

      {selection ? (
        <FloatingTip anchorRect={selection.anchorRect} onClose={closeSelection}>
          <HighlightToolbar
            copyText={selection.text}
            onPin={() => onPin(selection.text, selection.context)}
            onAddToQuestion={() => {
              onAddToQuestion("answer", selection.text);
              setSelection(null);
              window.getSelection()?.removeAllRanges();
              composerRef.current?.focus();
            }}
            addToQuestionTitle="Add to your next question"
          />
        </FloatingTip>
      ) : null}

      <QuestionComposer
        className="ask-composer"
        value={draft}
        onChange={setDraft}
        onSubmit={submit}
        placeholder={thread ? "Ask a follow-up…" : "Ask about this document…"}
        disabled={!hasDocument}
        busy={busy}
        submitLabel="Ask"
        busyLabel="…"
        attachments={attachments}
        pageLabel={pageLabel}
        onRemoveAttachment={onRemoveAttachment}
        textareaRef={composerRef}
      />
    </>
  );
}

// Earlier questions, opened from the header — a dropdown over the chat
// rather than a list taking room in it.
function HistoryMenu({
  store,
  threads,
  openThreadId,
  onOpen,
  onClose,
}: {
  store: AskStore;
  threads: AskThread[];
  openThreadId: string | null;
  onOpen: (threadId: string) => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element;
      if (ref.current?.contains(target) || target.closest?.(".ask-header-actions")) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const sorted = [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <div className="ask-history" ref={ref}>
      <ul className="ask-threads">
        {sorted.map((thread) => (
          <li key={thread.id} className={`ask-thread-item${thread.id === openThreadId ? " is-current" : ""}`}>
            {renaming === thread.id ? (
              <input
                className="ask-rename"
                defaultValue={thread.title}
                autoFocus
                onBlur={(event) => {
                  const title = event.target.value.trim();
                  if (title) store.update(thread.id, (t) => ({ ...t, title }));
                  setRenaming(null);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <button type="button" className="ask-thread-open" onClick={() => onOpen(thread.id)}>
                <span className="ask-thread-title">{thread.title}</span>
                <span className="ask-thread-meta">
                  {formatWhen(thread.updatedAt)} · {thread.turns.filter((t) => t.role === "user").length} asked
                </span>
              </button>
            )}
            <span className="ask-thread-actions">
              <button type="button" className="ask-icon-button" title="Rename" onClick={() => setRenaming(thread.id)}>
                <Pencil width={13} height={13} />
              </button>
              <button
                type="button"
                className="ask-icon-button"
                title="Delete"
                onClick={() => {
                  if (window.confirm(`Delete "${thread.title}"?`)) store.remove(thread.id);
                }}
              >
                <Trash2 width={13} height={13} />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnView({
  turn,
  isLast,
  pageLabel,
  onJump,
  onMoreDetail,
  onWider,
  onGeneral,
}: {
  turn: AskTurn;
  isLast: boolean;
  pageLabel: (n: number) => string;
  onJump: (ref: ResolvedRef) => void;
  onMoreDetail: () => void;
  onWider: () => void;
  onGeneral: () => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="ask-turn ask-turn-user">
        {turn.content}
        {turn.attachments?.length ? <AttachmentChips attachments={turn.attachments} pageLabel={pageLabel} /> : null}
      </div>
    );
  }

  const sources = turn.sources ?? [];
  if (turn.status === "error") return <div className="ask-turn ask-turn-assistant ask-turn-error">{turn.content}</div>;
  if (turn.status === "streaming" && !turn.content) {
    return (
      <div className="ask-turn ask-turn-assistant ask-thinking">
        Reading {sources.length} passage{sources.length === 1 ? "" : "s"}…
      </div>
    );
  }

  const streaming = turn.status === "streaming";
  const grounding = answerGrounding(parseAnswer(turn.content, sources));
  const notCovered = grounding === "not-covered";
  return (
    <div className="ask-turn ask-turn-assistant">
      {!streaming ? <AnswerBadge grounding={grounding} /> : null}
      <AnswerMarkdown content={turn.content} sources={sources} pageLabel={pageLabel} onJump={onJump} streaming={streaming} />
      {!streaming ? (
        <div className="answer-footer">
          {notCovered ? (
            <span />
          ) : (
            <SourcesFooter
              sent={sources}
              cited={citedSources(turn.content, sources)}
              pageLabel={pageLabel}
              onJump={onJump}
              summary={basisText(turn.basis, turn.scope, pageLabel)}
            />
          )}
          {isLast && !notCovered ? (
            <button type="button" className="answer-more" onClick={onMoreDetail}>
              More detail
            </button>
          ) : null}
        </div>
      ) : null}
      {!streaming && isLast && notCovered ? (
        <div className="ask-not-covered-actions">
          {!turn.wider && turn.basis?.kind !== "scope" ? (
            <button type="button" onClick={onWider}>
              Search wider
            </button>
          ) : null}
          <button type="button" onClick={onGeneral}>
            Answer from general knowledge
          </button>
        </div>
      ) : null}
    </div>
  );
}
