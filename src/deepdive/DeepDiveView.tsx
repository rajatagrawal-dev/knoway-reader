import type { RefObject } from "react";
import type { DiveHighlight, DivePanel } from "./types";
import { ancestorChain, paneWindow, panelById } from "./tree";
import DivePanelPane from "./DivePanelPane";

export interface DeepDiveViewProps {
  panels: DivePanel[];
  diveHighlights: DiveHighlight[];
  scrolledToDiveHighlightId: string | null;
  focusId: string;
  rootLabel: string;
  onFocusChange: (id: string | null) => void;
  rootSlotRef: RefObject<HTMLDivElement>;
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
  onAddHighlight,
  onEditHighlight,
  onDeleteHighlight,
  onDiveFromHighlight,
  onPin,
}: DeepDiveViewProps) {
  const chain = ancestorChain(panels, focusId, rootLabel);
  const paneEntries = paneWindow(chain);

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
      </nav>
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
                onOpenDive={onFocusChange}
                onSendMessage={onSendMessage}
                onNestedDive={onNestedDive}
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
