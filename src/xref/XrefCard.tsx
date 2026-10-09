import { useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, Pin, Sparkles, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useFlippedPlacement, type AnchorRect } from "../deepdive/useFlippedPlacement";
import { openExternal } from "../library/desktop";
import type { XrefRef, XrefTarget } from "./detect";
import { cropTarget } from "./preview";

const CARD_WIDTH = 420;
const VIEWPORT_MARGIN = 8;

const KIND_LABELS: Record<XrefTarget["kind"], string> = {
  equation: "Equation",
  theorem: "Statement",
  figure: "Figure",
  table: "Table",
  section: "Section",
  citation: "Reference",
  link: "Link",
};

// What a cross-reference points at, shown in place: the target cut from its
// page (or, for a citation, its bibliography entry), with a way there.
export function XrefPreview({
  xref,
  pdfDocument,
  pageLabel,
  onJump,
  onExplain,
  onPin,
  onClose,
}: {
  xref: XrefRef;
  pdfDocument: PDFDocumentProxy;
  pageLabel: (pageNumber: number) => string;
  onJump: (target: XrefTarget) => void;
  onExplain: (ref: XrefRef, target: XrefTarget) => void;
  onPin?: () => void; // absent on a pinned card, which has onClose instead
  onClose?: () => void;
}) {
  const primary = xref.targets[0];
  return (
    <div className="xref-preview">
      <div className="xref-preview-header">
        <span className="xref-preview-kind">{KIND_LABELS[primary.kind]}</span>
        <span className="xref-preview-name">{xref.targets.length > 1 ? xref.text : primary.name}</span>
        <span className="xref-preview-page">p. {pageLabel(primary.pageNumber)}</span>
        {onClose ? (
          <button type="button" className="xref-icon-button" onClick={onClose} title="Close">
            <X width={14} height={14} />
          </button>
        ) : null}
      </div>
      {primary.kind === "citation" ? (
        <ul className="xref-entries">
          {xref.targets.map((target) => (
            <li key={target.key}>
              <p className="xref-entry-text">{target.entryText}</p>
              <span className="xref-entry-actions">
                <button type="button" onClick={() => onJump(target)}>
                  Go to entry
                </button>
                {target.entryText ? (
                  <button
                    type="button"
                    onClick={() =>
                      void openExternal(
                        `https://scholar.google.com/scholar?q=${encodeURIComponent(target.entryText!.replace(/^\[\d+\]\s*/, "").slice(0, 250))}`,
                      )
                    }
                  >
                    <BookOpen width={12} height={12} /> Google Scholar
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <TargetImage pdfDocument={pdfDocument} target={primary} onClick={() => onJump(primary)} />
      )}
      <div className="xref-preview-actions">
        {primary.kind !== "citation" ? (
          <button type="button" onClick={() => onJump(primary)}>
            Go to p. {pageLabel(primary.pageNumber)} <ArrowRight width={12} height={12} />
          </button>
        ) : null}
        {onPin ? (
          <button type="button" onClick={onPin} title="Keep this preview open while you read">
            <Pin width={12} height={12} /> Pin
          </button>
        ) : null}
        <button type="button" onClick={() => onExplain(xref, primary)} title="Ask how the two passages connect">
          <Sparkles width={12} height={12} /> Explain the connection
        </button>
      </div>
    </div>
  );
}

function TargetImage({ pdfDocument, target, onClick }: { pdfDocument: PDFDocumentProxy; target: XrefTarget; onClick: () => void }) {
  const [image, setImage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    setImage(undefined);
    void cropTarget(pdfDocument, target).then((url) => {
      if (!cancelled) setImage(url);
    });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument, target]);
  if (image === undefined) return <div className="xref-image xref-image--loading" />;
  if (image === null) return <p className="xref-image-missing">Couldn't show a preview. Go to the page instead.</p>;
  return (
    <button type="button" className="xref-image" onClick={onClick} title="Go there">
      <img src={image} alt={target.name} />
    </button>
  );
}

// The hover card: a preview floating by the reference, flipped above or
// below it so it never covers it.
export function XrefHoverCard({
  anchorRect,
  onPointerEnter,
  onPointerLeave,
  ...preview
}: Parameters<typeof XrefPreview>[0] & {
  anchorRect: AnchorRect;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchor = {
    ...anchorRect,
    left: Math.max(VIEWPORT_MARGIN, Math.min(anchorRect.left - 40, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN)),
  };
  const placement = useFlippedPlacement(ref, anchor, [preview.xref.id]);
  return (
    <div
      ref={ref}
      className="xref-card"
      style={{ left: placement.left, top: placement.top, width: CARD_WIDTH }}
      role="tooltip"
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <XrefPreview {...preview} />
    </div>
  );
}
