import type { DivePanel } from "./types";
import { ancestorChain, paneWindow, panelById } from "./tree";
import DivePanelPane from "./DivePanelPane";
import PdfPane, { type PdfPaneProps } from "./PdfPane";

export interface DeepDiveViewProps {
  panels: DivePanel[];
  focusId: string;
  rootLabel: string;
  onFocusChange: (id: string | null) => void;
  pdfPaneProps: PdfPaneProps;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
}

export default function DeepDiveView({
  panels,
  focusId,
  rootLabel,
  onFocusChange,
  pdfPaneProps,
  onSendMessage,
  onNestedDive,
  onQuickMeaning,
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
              <PdfPane {...pdfPaneProps} />
            ) : (
              <DivePanelPane
                panel={panelById(panels, entry.id)!}
                allPanels={panels}
                onOpenDive={onFocusChange}
                onSendMessage={onSendMessage}
                onNestedDive={onNestedDive}
                onQuickMeaning={onQuickMeaning}
                onPin={onPin}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
