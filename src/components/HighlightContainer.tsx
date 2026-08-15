import {
  AreaHighlight,
  FreetextHighlight,
  TextHighlight,
  useHighlightContainerContext,
  usePdfHighlighterContext,
} from "react-pdf-highlighter-plus";
import { useHighlightCommentControls } from "./HighlightPopup";
import DiveBadge from "../deepdive/DiveBadge";
import type { CommentedHighlight } from "../types";

interface HighlightContainerProps {
  editHighlight: (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => void;
  deleteHighlight: (highlightId: string) => void;
  onOpenDive: (divePanelId: string) => void;
}

export default function HighlightContainer({
  editHighlight,
  deleteHighlight,
  onOpenDive,
}: HighlightContainerProps) {
  const {
    highlight,
    viewportToScaled,
    screenshot,
    isScrolledTo,
    highlightBindings,
  } = useHighlightContainerContext<CommentedHighlight>();

  const { toggleEditInProgress } = usePdfHighlighterContext();

  const commentControls = useHighlightCommentControls(
    highlight,
    (edit) => editHighlight(highlight.id, edit),
    highlight.type === "text" ? "TextHighlight" : "AreaHighlight",
  );

  const diveBadge = highlight.divePanelId ? (
    <DiveBadge onClick={() => onOpenDive(highlight.divePanelId!)} />
  ) : null;

  if (highlight.type === "text") {
    return (
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        onStyleChange={(style) => editHighlight(highlight.id, style)}
        onDelete={() => deleteHighlight(highlight.id)}
        extraButtons={
          <>
            {commentControls.button}
            {diveBadge}
          </>
        }
        extraPanel={commentControls.panel}
      />
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

  return (
    <AreaHighlight
      highlight={highlight}
      isScrolledTo={isScrolledTo}
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
          {diveBadge}
        </>
      }
      extraPanel={commentControls.panel}
    />
  );
}
