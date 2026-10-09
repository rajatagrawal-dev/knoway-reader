import { useState, type RefObject } from "react";
import { FileText } from "lucide-react";
import type { DiveHighlight, DiveHighlightPlacement, DivePanel } from "./types";
import type { Attachment } from "../grounding/attachments";
import type { SourceRef } from "../grounding/types";
import { ancestorChain, paneWindow, panelById } from "./tree";
import DivePanelPane, { type DivePanelPaneProps } from "./DivePanelPane";
import { useExperiments } from "./experiments";
import DiveMap from "./DiveMap";
import TreeSummaryPanel from "./TreeSummaryPanel";

export interface DeepDiveViewProps {
  panels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  focusId: string;
  rootLabel: string;
  onFocusChange: (id: string | null) => void;
  rootSlotRef: RefObject<HTMLDivElement>;
  onSendMessage: DivePanelPaneProps["onSendMessage"];
  onNestedDive: (request: { parentId: string; selection: string; contextText: string } & DiveHighlightPlacement) => void;
  onSuggestedDive: DivePanelPaneProps["onSuggestedDive"];
  onSummarizeTree: (rootId: string, onChunk: (chunk: string) => void, onSources: (sources: SourceRef[]) => void) => Promise<void>;
  pageLabel: DivePanelPaneProps["pageLabel"];
  onJumpToSource: DivePanelPaneProps["onJumpToSource"];
  attachments: Record<string, Attachment[]>; // per dive
  onAddToQuestion: (divePanelId: string, kind: Attachment["kind"], text: string, pageNumber?: number) => void;
  onRemoveAttachment: (divePanelId: string, id: string) => void;
  onClearAttachments: (divePanelId: string) => void;
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

const NO_ATTACHMENTS: Attachment[] = [];

export default function DeepDiveView({
  panels,
  diveHighlights,
  scrolledToDiveHighlightId,
  focusId,
  rootLabel,
  onFocusChange,
  rootSlotRef,
  onSendMessage,
  onNestedDive,
  onSuggestedDive,
  onSummarizeTree,
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
}: DeepDiveViewProps) {
  const experiments = useExperiments();
  const [summaryOpenFor, setSummaryOpenFor] = useState<string | null>(null);
  const chain = ancestorChain(panels, focusId, rootLabel);
  const paneEntries = paneWindow(chain);
  // The dive this tree started from (chain[0] is the PDF itself).
  const root = chain[1]?.id ? panelById(panels, chain[1].id) : null;

  return (
    <div className="deep-dive-view">
      <nav className="deep-dive-breadcrumb">
        {chain.map((entry, index) => (
          <span key={entry.id ?? "root"} className="deep-dive-crumb-group">
            <button
              type="button"
              className={`deep-dive-crumb${index === chain.length - 1 ? " current" : ""}`}
              onClick={() => onFocusChange(entry.id)}
            >
              {entry.label}
            </button>
            {index < chain.length - 1 ? <span className="deep-dive-crumb-sep">›</span> : null}
          </span>
        ))}
        {root && (experiments.diveMap || experiments.treeSummary) ? (
          <span className="deep-dive-tools">
            {experiments.diveMap ? (
              <DiveMap panels={panels} rootId={root.id} focusId={focusId} onFocus={onFocusChange} pageLabel={pageLabel} />
            ) : null}
            {experiments.treeSummary ? (
              <span className="deep-dive-tool">
                <button
                  type="button"
                  className={`deep-dive-tool-button${summaryOpenFor === root.id ? " active" : ""}`}
                  onClick={() => setSummaryOpenFor((open) => (open === root.id ? null : root.id))}
                  title="A one-page summary of every dive from this passage"
                >
                  <FileText width={14} height={14} aria-hidden="true" />
                  Summary
                </button>
              </span>
            ) : null}
          </span>
        ) : null}
      </nav>
      {experiments.treeSummary && root && summaryOpenFor === root.id ? (
        <TreeSummaryPanel
          key={root.id}
          root={root}
          panels={panels}
          pageLabel={pageLabel}
          onJumpToSource={onJumpToSource}
          onSummarize={onSummarizeTree}
          onClose={() => setSummaryOpenFor(null)}
        />
      ) : null}
      <div className="deep-dive-panes">
        {paneEntries.map((entry) => (
          <div className="deep-dive-pane" key={entry.id ?? "root"}>
            {entry.id === null ? (
              <div className="pdf-pane-slot" ref={rootSlotRef} />
            ) : (
              <DivePanelPane
                panel={panelById(panels, entry.id)!}
                allPanels={panels}
                diveHighlights={diveHighlights}
                scrolledToDiveHighlightId={scrolledToDiveHighlightId}
                focusedPanelId={focusId}
                onOpenDive={onFocusChange}
                onSendMessage={onSendMessage}
                onNestedDive={onNestedDive}
                onSuggestedDive={onSuggestedDive}
                pageLabel={pageLabel}
                onJumpToSource={onJumpToSource}
                attachments={attachments[entry.id] ?? NO_ATTACHMENTS}
                onAddToQuestion={(kind, text, pageNumber) => onAddToQuestion(entry.id!, kind, text, pageNumber)}
                onRemoveAttachment={(id) => onRemoveAttachment(entry.id!, id)}
                onClearAttachments={() => onClearAttachments(entry.id!)}
                onAddHighlight={onAddHighlight}
                onEditHighlight={onEditHighlight}
                onDeleteHighlight={onDeleteHighlight}
                onDiveFromHighlight={onDiveFromHighlight}
                onPin={onPin}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
