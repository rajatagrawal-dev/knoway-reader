import type { ReactNode } from "react";
import {
  AreaHighlight,
  FreetextHighlight,
  MonitoredHighlightContainer,
  TextHighlight,
  useHighlightContainerContext,
  usePdfHighlighterContext,
} from "react-pdf-highlighter-plus";
import { useNoteControl } from "./NoteControl";
import DiveControl from "../deepdive/DiveControl";
import type { CommentedHighlight } from "../types";

interface HighlightContainerProps {
  editHighlight: (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => void;
  deleteHighlight: (highlightId: string) => void;
  onOpenDive: (divePanelId: string) => void;
  onStartDive: (
    highlightId: string,
    content: CommentedHighlight["content"],
    pageNumber: number,
  ) => void;
}

export default function HighlightContainer({
  editHighlight,
  deleteHighlight,
  onOpenDive,
  onStartDive,
}: HighlightContainerProps) {
  const {
    highlight,
    viewportToScaled,
    screenshot,
    isScrolledTo,
    highlightBindings,
  } = useHighlightContainerContext<CommentedHighlight>();

  const { toggleEditInProgress } = usePdfHighlighterContext();

  const commentControls = useNoteControl({
    comment: highlight.comment,
    onCommit: (comment) => editHighlight(highlight.id, { comment }),
    classPrefix: highlight.type === "text" ? "TextHighlight" : "AreaHighlight",
  });

  const diveControl = (
    <DiveControl
      divePanelId={highlight.divePanelId}
      onOpen={onOpenDive}
      onStart={() => onStartDive(highlight.id, highlight.content, highlight.position.boundingRect.pageNumber)}
    />
  );

  const commentTip = highlight.comment ? (
    <div className="highlight-comment-tooltip">{highlight.comment}</div>
  ) : null;

  const withCommentTip = (element: ReactNode) =>
    commentTip ? (
      <MonitoredHighlightContainer
        highlightTip={{ position: highlight.position, content: commentTip }}
      >
        {element}
      </MonitoredHighlightContainer>
    ) : (
      element
    );

  if (highlight.type === "text") {
    return withCommentTip(
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        highlightColor={highlight.highlightColor}
        highlightStyle={highlight.highlightStyle}
        onStyleChange={(style) => editHighlight(highlight.id, style)}
        onDelete={() => deleteHighlight(highlight.id)}
        extraButtons={
          <>
            {commentControls.button}
            {diveControl}
          </>
        }
        extraPanel={commentControls.panel}
      />,
    );
  }

  if (highlight.type === "freetext") {
    return (
      <FreetextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        onChange={(boundingRect) => {
          editHighlight(highlight.id, {
            position: {
              boundingRect: viewportToScaled(boundingRect),
              rects: [],
            },
          });
          toggleEditInProgress(false);
        }}
        onTextChange={(newText) => {
          editHighlight(highlight.id, {
            content: { text: newText },
          });
        }}
        onStyleChange={(style) => {
          editHighlight(highlight.id, {
            color: style.color,
            backgroundColor: style.backgroundColor,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
          });
        }}
        onEditStart={() => toggleEditInProgress(true)}
        onEditEnd={() => toggleEditInProgress(false)}
        onDelete={() => deleteHighlight(highlight.id)}
      />
    );
  }

  return withCommentTip(
    <AreaHighlight
      highlight={highlight}
      isScrolledTo={isScrolledTo}
      highlightColor={highlight.highlightColor}
      onStyleChange={(style) => editHighlight(highlight.id, style)}
      onDelete={() => deleteHighlight(highlight.id)}
      onChange={(boundingRect) => {
        editHighlight(highlight.id, {
          position: {
            boundingRect: viewportToScaled(boundingRect),
            rects: [],
          },
          content: {
            image: screenshot(boundingRect),
          },
        });
        toggleEditInProgress(false);
      }}
      bounds={highlightBindings.textLayer}
      onEditStart={() => toggleEditInProgress(true)}
      extraButtons={
        <>
          {commentControls.button}
          {diveControl}
        </>
      }
      extraPanel={commentControls.panel}
    />,
  );
}
