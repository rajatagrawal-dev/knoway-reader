import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMathNotation } from "../deepdive/mathNotation";
import { ExternalLink, Star } from "lucide-react";
import { openExternal } from "../library/desktop";
import { originLabel, referenceMarkdown } from "./format";
import type { GlossaryEntry, GlossaryOrigin, GlossaryRef, GlossaryReference, GlossarySource, OriginKind } from "./types";

const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [remarkMath];
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];

// A glossary definition: a sentence or three of markdown with inline math.
// Math is normalized like dive replies, minus promoting equations onto
// their own lines — a definition is meant to read as one short paragraph.
export function DefinitionText({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={`glossary-definition${streaming ? " is-streaming" : ""}${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
        {normalizeMathNotation(text, { promote: false })}
      </ReactMarkdown>
    </div>
  );
}

const SOURCE_LABELS: Record<GlossarySource, { label: string; title: string }> = {
  defined: { label: "Defined in text", title: "The document itself defines or introduces this term." },
  inferred: { label: "Inferred", title: "Worked out from how the document uses the term." },
  general: { label: "General meaning", title: "The document doesn't explain this term; this is its usual meaning in the field." },
};

export function SourceBadge({ source }: { source?: GlossarySource }) {
  if (!source) return null;
  const { label, title } = SOURCE_LABELS[source];
  return (
    <span className={`source-badge glossary-source glossary-source--${source}`} title={title}>
      {label}
    </span>
  );
}

const ORIGIN_TITLES: Record<OriginKind, string> = {
  common: "An everyday word of the language, used here in its ordinary sense.",
  technical: "A term with a specific meaning in this field.",
  foreign: "A word or phrase borrowed from another language.",
  name: "A proper name.",
  abbreviation: "An abbreviation or acronym.",
};

// Where the term comes from — shown beside the term itself.
export function OriginBadge({ origin, term }: { origin?: GlossaryOrigin; term: string }) {
  if (!origin) return null;
  return (
    <span className={`source-badge glossary-origin glossary-origin--${origin.kind}`} title={ORIGIN_TITLES[origin.kind]}>
      {originLabel(origin, term)}
    </span>
  );
}

// Says where the definition below it comes from: the document (and, when
// the document defines the term, a link to that passage) or, failing that,
// the term's general meaning.
function DocumentCaption({
  entry,
  pageLabel,
  onJumpToRef,
}: {
  entry: GlossaryEntry;
  pageLabel: (pageNumber: number) => string;
  onJumpToRef?: (ref: GlossaryRef) => void;
}) {
  if (!entry.source) return null;
  const { title } = SOURCE_LABELS[entry.source];
  if (entry.source === "general") {
    return (
      <p className="glossary-sense-caption" title={title}>
        General meaning · not explained in this document
      </p>
    );
  }
  const definedRef = entry.definedRefId ? entry.refs.find((ref) => ref.id === entry.definedRefId) : undefined;
  return (
    <p className="glossary-sense-caption" title={title}>
      In this document ·{" "}
      {entry.source === "inferred" ? (
        "from context"
      ) : definedRef && onJumpToRef ? (
        <button type="button" className="glossary-caption-link" onClick={() => onJumpToRef(definedRef)}>
          <Star width={10} height={10} fill="currentColor" /> defined on p. {pageLabel(definedRef.pageNumber)}
        </button>
      ) : definedRef ? (
        `defined on p. ${pageLabel(definedRef.pageNumber)}`
      ) : (
        "defined in the text"
      )}
    </p>
  );
}

// The dictionary or encyclopedia entry matching the document's sense,
// verbatim, with a link to the page it came from.
function ReferenceSense({ reference }: { reference: GlossaryReference }) {
  return (
    <div className="glossary-sense glossary-sense--reference">
      <p className="glossary-sense-caption">
        <button
          type="button"
          className="glossary-caption-link"
          title={`Open on ${reference.site}`}
          onClick={() => void openExternal(reference.url)}
        >
          {reference.site} · {reference.label} <ExternalLink width={10} height={10} />
        </button>
      </p>
      <DefinitionText className="glossary-reference-text" text={referenceMarkdown(reference.text)} />
    </div>
  );
}

// A term's meaning, each part labelled with its source: the literal
// meaning of a foreign word or idiom, the definition as this document uses
// it, and the matching dictionary/encyclopedia entry.
export function GlossaryMeaning({
  entry,
  pageLabel = String,
  onJumpToRef,
}: {
  entry: GlossaryEntry;
  pageLabel?: (pageNumber: number) => string;
  onJumpToRef?: (ref: GlossaryRef) => void;
}) {
  return (
    <div className="glossary-meaning">
      {entry.literal ? (
        <p className="glossary-literal">
          Literally <q>{entry.literal}</q>
        </p>
      ) : null}
      <div className="glossary-sense">
        <DocumentCaption entry={entry} pageLabel={pageLabel} onJumpToRef={onJumpToRef} />
        <DefinitionText text={entry.definition} streaming={entry.status === "streaming"} />
      </div>
      {entry.reference ? <ReferenceSense reference={entry.reference} /> : null}
    </div>
  );
}
