import { useRef, useState, type ReactNode } from "react";
import type { DivePanel } from "./types";
import { childrenOf } from "./tree";
import { useSelectionCapture } from "./useSelectionCapture";
import SelectionPopover from "./SelectionPopover";

export interface DivePanelPaneProps {
  panel: DivePanel;
  allPanels: DivePanel[];
  onOpenDive: (panelId: string) => void;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
}

// Wraps any substring of `content` matching one of `children`'s `selection`
// in a clickable marker. Matches are found independently per child, sorted
// by position, and overlapping matches are dropped (first match wins) —
// approximate on purpose: this is a self-use app, not a rich-text editor.
function renderTurnContent(
  content: string,
  children: DivePanel[],
  onOpenDive: (panelId: string) => void,
): ReactNode {
  if (children.length === 0) return content;

  const matches: { start: number; end: number; panel: DivePanel }[] = [];
  for (const child of children) {
    if (!child.selection) continue;
    const start = content.indexOf(child.selection);
    if (start !== -1) {
      matches.push({ start, end: start + child.selection.length, panel: child });
    }
  }
  if (matches.length === 0) return content;

  matches.sort((a, b) => a.start - b.start);
  const nonOverlapping: typeof matches = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    nonOverlapping.push(match);
    cursor = match.end;
  }

  const nodes: ReactNode[] = [];
  let pos = 0;
  nonOverlapping.forEach((match, index) => {
    if (match.start > pos) nodes.push(content.slice(pos, match.start));
    nodes.push(
      <button
        type="button"
        key={`${match.panel.id}-${index}`}
        className="dive-turn-marker"
        onClick={(event) => {
          event.stopPropagation();
          onOpenDive(match.panel.id);
        }}
      >
        {content.slice(match.start, match.end)}
      </button>,
    );
    pos = match.end;
  });
  if (pos < content.length) nodes.push(content.slice(pos));
  return nodes;
}

export default function DivePanelPane({
  panel,
  allPanels,
  onOpenDive,
  onSendMessage,
  onNestedDive,
  onQuickMeaning,
  onPin,
}: DivePanelPaneProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const dialogueRef = useRef<HTMLDivElement>(null);
  const { captured, clear } = useSelectionCapture(dialogueRef, ".dive-turn");
  const children = childrenOf(allPanels, panel.id);

  const send = async (content: string) => {
    if (!content.trim() || pending) return;
    setPending(true);
    setStreamingReply("");
    await onSendMessage(panel.id, content, (chunk) => setStreamingReply((prev) => prev + chunk));
    setStreamingReply("");
    setPending(false);
  };

  return (
    <div className="dive-panel-pane">
      <header className="dive-panel-header">{panel.label}</header>
      <div className="dive-panel-dialogue" ref={dialogueRef}>
        {panel.turns.map((turn, index) => (
          <div key={index} className={`dive-turn dive-turn-${turn.role}`}>
            {renderTurnContent(turn.content, children, onOpenDive)}
          </div>
        ))}
        {pending ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply || "…"}
          </div>
        ) : null}
      </div>
      {captured ? (
        <SelectionPopover
          selection={captured.text}
          position={captured.position}
          onDiveDeeper={() => {
            onNestedDive({ parentId: panel.id, selection: captured.text, contextText: captured.context });
            clear();
          }}
          onQuickMeaning={() => onQuickMeaning(captured.text, captured.context)}
          onPin={() => {
            onPin(captured.text, captured.context);
            clear();
          }}
          onClose={clear}
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
