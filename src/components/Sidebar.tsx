import type { PDFDocumentProxy } from "pdfjs-dist";
import type { CommentedHighlight } from "../types";
import type { DiveHighlight, DivePanel, GeneralNote, Pin } from "../deepdive/types";
import AnnotationsPanel from "./AnnotationsPanel";
import TableOfContentsPanel from "./TableOfContentsPanel";
import GlossaryPanel, { type GlossaryFocusRequest } from "./GlossaryPanel";
import SearchPanel, { type SearchMatch } from "./SearchPanel";
import type { GlossaryStore } from "../glossary/store";
import type { GlossaryRef } from "../glossary/types";
import AskPanel from "../ask/AskPanel";
import type { AskContext } from "../ask/job";
import type { AskStore } from "../ask/store";
import type { ResolvedRef } from "../grounding/CitationChip";
import type { Attachment } from "../grounding/attachments";

export type SidebarPanel = "annotations" | "toc" | "glossary" | "search" | "ask";

interface SidebarProps {
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
  activePanel: SidebarPanel | null;
  onSelectPanel: (panel: SidebarPanel) => void;
  pdfDocument: PDFDocumentProxy | null;
  pageLabels: string[] | null;
  currentPage: number;
  onGoToPage: (pageNumber: number) => void;
  glossaryStore: GlossaryStore;
  glossaryFocusRequest: GlossaryFocusRequest | null;
  onJumpToGlossaryRef: (ref: GlossaryRef) => void;
  onRetryGlossaryEntry: (entryId: string) => void;
  onDeleteGlossaryEntry: (entryId: string) => void;
  glossaryMarksVisible: boolean;
  onGlossaryMarksVisibleChange: (visible: boolean) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchFocusRequest: number;
  onJumpToSearchMatch: (match: SearchMatch) => void;
  askStore: AskStore;
  getAskContext: () => AskContext | null;
  openAskThreadId: string | null;
  onOpenAskThread: (threadId: string | null) => void;
  askFocusRequest: number;
  onJumpToSource: (ref: ResolvedRef) => void;
  askAttachments: Attachment[];
  onAddToAsk: (kind: Attachment["kind"], text: string) => void;
  onRemoveAskAttachment: (id: string) => void;
  onClearAskAttachments: () => void;
  onPin: (text: string, context: string) => void;
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === "left" ? "15 6 9 12 15 18" : "9 6 15 12 9 18"} />
    </svg>
  );
}

export default function Sidebar({
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
  activePanel,
  onSelectPanel,
  pdfDocument,
  pageLabels,
  currentPage,
  onGoToPage,
  glossaryStore,
  glossaryFocusRequest,
  onJumpToGlossaryRef,
  onRetryGlossaryEntry,
  onDeleteGlossaryEntry,
  glossaryMarksVisible,
  onGlossaryMarksVisibleChange,
  searchQuery,
  onSearchQueryChange,
  searchFocusRequest,
  onJumpToSearchMatch,
  askStore,
  getAskContext,
  openAskThreadId,
  onOpenAskThread,
  askFocusRequest,
  onJumpToSource,
  askAttachments,
  onAddToAsk,
  onRemoveAskAttachment,
  onClearAskAttachments,
  onPin,
}: SidebarProps) {
  // The rail that picks the panel is AppRail, shared with Deep Dive; this is
  // only the open panel itself.
  if (!activePanel) return null;

  return (
    <aside className="sidebar">
      <div className="sidebar-panel">
        <button
          type="button"
          className="sidebar-collapse-button"
          onClick={() => onSelectPanel(activePanel)}
          title="Collapse panel"
          aria-label="Collapse panel"
        >
          <ChevronIcon direction="left" />
        </button>
        {activePanel === "annotations" ? (
          <AnnotationsPanel
            highlights={highlights}
            pins={pins}
            panels={panels}
            diveHighlights={diveHighlights}
            scrolledToHighlightId={scrolledToHighlightId}
            onJumpToHighlight={onJumpToHighlight}
            onDeleteHighlight={onDeleteHighlight}
            onEditHighlightComment={onEditHighlightComment}
            onEditFreetextText={onEditFreetextText}
            onHoverHighlight={onHoverHighlight}
            onOpenDiveFromHighlight={onOpenDiveFromHighlight}
            onJumpToSource={onJumpToSource}
            onDeletePin={onDeletePin}
            onEditPinComment={onEditPinComment}
            onOpenDiveHighlight={onOpenDiveHighlight}
            onDeleteDiveHighlight={onDeleteDiveHighlight}
            onEditDiveHighlightComment={onEditDiveHighlightComment}
            generalNotes={generalNotes}
            onAddNote={onAddNote}
            onEditGeneralNote={onEditGeneralNote}
            onDeleteGeneralNote={onDeleteGeneralNote}
            pageLabels={pageLabels}
            pdfDocument={pdfDocument}
            currentPage={currentPage}
          />
        ) : activePanel === "search" ? (
          <SearchPanel
            pdfDocument={pdfDocument}
            pageLabels={pageLabels}
            query={searchQuery}
            onQueryChange={onSearchQueryChange}
            focusRequest={searchFocusRequest}
            onJumpToMatch={onJumpToSearchMatch}
          />
        ) : activePanel === "ask" ? (
          <AskPanel
            store={askStore}
            getContext={getAskContext}
            hasDocument={Boolean(pdfDocument)}
            pageLabels={pageLabels}
            openThreadId={openAskThreadId}
            onOpenThread={onOpenAskThread}
            onJumpToSource={onJumpToSource}
            focusRequest={askFocusRequest}
            attachments={askAttachments}
            onAddToQuestion={onAddToAsk}
            onRemoveAttachment={onRemoveAskAttachment}
            onClearAttachments={onClearAskAttachments}
            onPin={onPin}
          />
        ) : activePanel === "glossary" ? (
          <GlossaryPanel
            store={glossaryStore}
            pageLabels={pageLabels}
            focusRequest={glossaryFocusRequest}
            onJumpToRef={onJumpToGlossaryRef}
            onRetry={onRetryGlossaryEntry}
            onDelete={onDeleteGlossaryEntry}
            marksVisible={glossaryMarksVisible}
            onMarksVisibleChange={onGlossaryMarksVisibleChange}
          />
        ) : (
          <TableOfContentsPanel
            pdfDocument={pdfDocument}
            currentPage={currentPage}
            goToPage={onGoToPage}
            pageLabels={pageLabels}
          />
        )}
      </div>
    </aside>
  );
}
