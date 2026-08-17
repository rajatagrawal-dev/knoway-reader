import { cloneElement, Fragment, isValidElement, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
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

// Wraps any substring of `text` matching one of `children`'s `selection` in a
// clickable marker. Matches are found independently per child, sorted by
// position, and overlapping matches are dropped (first match wins) —
// approximate on purpose: this is a self-use app, not a rich-text editor.
function wrapMarkersInText(
  text: string,
  children: DivePanel[],
  onOpenDive: (panelId: string) => void,
): ReactNode {
  if (children.length === 0) return text;

  const matches: { start: number; end: number; panel: DivePanel }[] = [];
  for (const child of children) {
    if (!child.selection) continue;
    const start = text.indexOf(child.selection);
    if (start !== -1) {
      matches.push({ start, end: start + child.selection.length, panel: child });
    }
  }
  if (matches.length === 0) return text;

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
    if (match.start > pos) nodes.push(text.slice(pos, match.start));
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
        {text.slice(match.start, match.end)}
      </button>,
    );
    pos = match.end;
  });
  if (pos < text.length) nodes.push(text.slice(pos));
  return nodes;
}

// Applies wrapMarkersInText to the plain-string children of a rendered
// markdown element, recursing into inline-formatting elements (<strong>,
// <em>, <code>, ...) so a dived-into phrase still gets the clickable
// marker even when part of it is bold/italic/etc.
function wrapMarkerChildren(
  node: ReactNode,
  children: DivePanel[],
  onOpenDive: (panelId: string) => void,
): ReactNode {
  if (typeof node === "string") return wrapMarkersInText(node, children, onOpenDive);
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      <Fragment key={index}>{wrapMarkerChildren(child, children, onOpenDive)}</Fragment>
    ));
  }
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children !== undefined) {
    return cloneElement(node, undefined, wrapMarkerChildren(node.props.children, children, onOpenDive));
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
  onOpenDive: (panelId: string) => void,
): Components {
  return useMemo(() => {
    const wrap = (node: ReactNode) => wrapMarkerChildren(node, children, onOpenDive);
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
  }, [children, onOpenDive]);
}

// The model is instructed to wrap math in $...$/$$...$$ but doesn't always
// comply for a one-off exponent mentioned mid-sentence (e.g. "e^(iφ)"). This
// is a deterministic backstop: find base^exponent patterns that aren't
// already inside math or code, and wrap just that piece as inline LaTeX so
// KaTeX renders a real superscript regardless of what the model did.
// Content is split on existing $$...$$, $...$, and `...` spans (kept
// verbatim); the caret pattern is only rewritten in what's left over.
const PROTECTED_SPAN = /(\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|`[^`\n]+?`)/g;
const CARET_EXPONENT = /([\p{L}\p{N}]+|\([^()\n]{1,40}\))\^(\([^()\n]{1,40}\)|[\p{L}\p{N}]{1,20})/gu;

function autoWrapCaretExponents(markdown: string): string {
  return markdown
    .split(PROTECTED_SPAN)
    .map((part, index) => {
      if (index % 2 === 1) return part; // a protected math/code span — leave untouched
      return part.replace(CARET_EXPONENT, (_match, base: string, exponent: string) => {
        const clean = exponent.startsWith("(") ? exponent.slice(1, -1) : exponent;
        return `$${base}^{${clean}}$`;
      });
    })
    .join("");
}

function renderTurnContent(content: string, components: Components): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={components}
    >
      {autoWrapCaretExponents(content)}
    </ReactMarkdown>
  );
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
  const children = useMemo(() => childrenOf(allPanels, panel.id), [allPanels, panel.id]);
  const markdownComponents = useMarkdownComponents(children, onOpenDive);

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
            {renderTurnContent(turn.content, markdownComponents)}
          </div>
        ))}
        {pending ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply ? renderTurnContent(streamingReply, markdownComponents) : "…"}
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
