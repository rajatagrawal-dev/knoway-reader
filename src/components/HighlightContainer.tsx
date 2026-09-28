import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import {
  AreaHighlight,
  FreetextHighlight,
  MonitoredHighlightContainer,
  TextHighlight,
  useHighlightContainerContext,
  usePdfHighlighterContext,
} from "react-pdf-highlighter-plus";
import { useNoteControl } from "./NoteControl";
import HighlightToolbar from "./HighlightToolbar";
import { HIGHLIGHT_COLOR_PRESETS } from "../highlightColors";
import type { CommentedHighlight } from "../types";
import { measureFreetextSize } from "../freetextSize";
import {
  STICKER_FONTS,
  STICKER_INK_DEFAULT,
  STICKER_INK_NAMES,
  STICKER_INK_PRESETS,
  STICKER_PAPER_NAMES,
  STICKER_PAPER_PRESETS,
  resolveStickerPaper,
  stickerStyle,
} from "../stickerStyles";

interface HighlightContainerProps {
  editHighlight: (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => void;
  deleteHighlight: (highlightId: string) => void;
  onOpenDive: (divePanelId: string) => void;
  isDiveOpen: (divePanelId: string) => boolean;
  onStartDive: (
    highlightId: string,
    content: CommentedHighlight["content"],
    pageNumber: number,
  ) => void;
  notesCollapsed: boolean;
}

export default function HighlightContainer(props: HighlightContainerProps) {
  const { highlight } = useHighlightContainerContext<CommentedHighlight>();
  if (highlight.glossaryFlash) return <GlossaryFlash />;
  return <AnnotationHighlight {...props} />;
}

// Briefly pulses the rects of a glossary reference just jumped to, then
// fades out; it has no toolbar, tip or interaction of its own.
function GlossaryFlash() {
  const { highlight } = useHighlightContainerContext<CommentedHighlight>();
  return (
    <div className="glossary-flash" aria-hidden="true">
      {highlight.position.rects.map((rect, index) => (
        <div
          key={index}
          className="glossary-flash-part"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </div>
  );
}

function AnnotationHighlight({
  editHighlight,
  deleteHighlight,
  notesCollapsed,
  onOpenDive,
  isDiveOpen,
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

  const isText = highlight.type === "text";

  // Only mounted while the library shows its toolbar group (selected or
  // scrolled-to): an always-present color row reserves layout space in the
  // highlight-config-layer and ends up eating clicks on the highlight itself.
  const renderToolbar = ({ visible }: { visible: boolean }) =>
    visible ? (
      <HighlightToolbar
        classPrefix={isText ? "TextHighlight" : "AreaHighlight"}
        copyText={highlight.content?.text || undefined}
        note={commentControls}
        divePanelId={highlight.divePanelId}
        onOpenDive={onOpenDive}
        onStartDive={() => onStartDive(highlight.id, highlight.content, highlight.position.boundingRect.pageNumber)}
        onDelete={() => deleteHighlight(highlight.id)}
        activeStyle={highlight.highlightStyle ?? "highlight"}
        onStyleChange={isText ? (highlightStyle) => editHighlight(highlight.id, { highlightStyle }) : undefined}
        activeColor={highlight.highlightColor ?? HIGHLIGHT_COLOR_PRESETS[0]}
        onColorChange={(highlightColor) => editHighlight(highlight.id, { highlightColor })}
      />
    ) : null;

  // Dived-into text opens its dive on the first click; only once that dive
  // is already open does a click select the highlight and show its toolbar.
  const shouldSelect = () => {
    if (highlight.divePanelId && !isDiveOpen(highlight.divePanelId)) {
      onOpenDive(highlight.divePanelId);
      return false;
    }
    return true;
  };

  const commentTip = highlight.comment ? (
    <div className="highlight-comment-tooltip">{highlight.comment}</div>
  ) : null;

  // Tags the highlight's DOM with its id so the annotations panel can
  // outline it on row hover (see hoveredHighlightId in App.tsx) without
  // re-rendering the page's highlight layer. display: contents keeps the
  // wrapper out of layout, so the library's absolute positioning is unaffected.
  const anchor = (element: ReactNode) => (
    <div className="highlight-anchor" data-highlight-id={highlight.id}>
      {element}
    </div>
  );

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
    return anchor(withCommentTip(
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        highlightColor={highlight.highlightColor}
        highlightStyle={highlight.highlightStyle}
        onStyleChange={(style) => editHighlight(highlight.id, style)}
        onDelete={() => deleteHighlight(highlight.id)}
        renderToolbar={renderToolbar}
        shouldSelect={shouldSelect}
      />,
    ));
  }

  if (highlight.type === "freetext") {
    const paper = resolveStickerPaper(highlight.backgroundColor);
    return anchor(
      <FreetextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        // The library only renders the style it's handed — it keeps none of
        // its own — so the saved style has to be passed back in every render.
        color={highlight.color ?? STICKER_INK_DEFAULT}
        backgroundColor={paper}
        fontSize={highlight.fontSize ?? "14px"}
        fontFamily={highlight.fontFamily ?? "inherit"}
        style={stickerStyle(paper)}
        backgroundColorPresets={STICKER_PAPER_PRESETS}
        backgroundColorNames={STICKER_PAPER_NAMES}
        textColorPresets={STICKER_INK_PRESETS}
        textColorNames={STICKER_INK_NAMES}
        fontFamilyOptions={STICKER_FONTS}
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
          // Keeps the note's box hugging its text as it's edited — otherwise
          // it stays whatever fixed size it was created/resized at, however
          // much shorter or longer the new text is.
          const { width, height } = measureFreetextSize(newText, highlight.fontSize, highlight.fontFamily);
          editHighlight(highlight.id, {
            content: { text: newText },
            position: {
              boundingRect: viewportToScaled({ ...highlight.position.boundingRect, width, height }),
              rects: [],
            },
          });
        }}
        onStyleChange={(style) => {
          // Each change carries only the one property that changed; the
          // others are left as-is rather than overwritten with undefined.
          const fontSize = style.fontSize ?? highlight.fontSize;
          const fontFamily = style.fontFamily ?? highlight.fontFamily;
          const { width, height } = measureFreetextSize(highlight.content?.text ?? "", fontSize, fontFamily);
          editHighlight(highlight.id, {
            color: style.color ?? highlight.color,
            backgroundColor: style.backgroundColor ?? highlight.backgroundColor,
            fontSize,
            fontFamily,
            position: {
              boundingRect: viewportToScaled({ ...highlight.position.boundingRect, width, height }),
              rects: [],
            },
          });
        }}
        onEditStart={() => toggleEditInProgress(true)}
        onEditEnd={() => toggleEditInProgress(false)}
        onDelete={() => deleteHighlight(highlight.id)}
        compact={notesCollapsed}
        compactSize={28}
        compactIcon={<MessageSquare width={15} height={15} />}
      />,
    );
  }

  return anchor(withCommentTip(
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
      renderToolbar={renderToolbar}
      shouldSelect={shouldSelect}
    />,
  ));
}
