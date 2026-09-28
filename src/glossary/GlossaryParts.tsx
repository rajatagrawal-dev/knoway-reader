import ReactMarkdown, { type Options as MarkdownOptions } from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMathNotation } from "../deepdive/mathNotation";
import type { GlossarySource } from "./types";

const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [remarkMath];
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [[rehypeKatex, { throwOnError: false, strict: false }]];

// A glossary definition: a sentence or three of markdown with inline math.
// Math is normalized like dive replies, minus promoting equations onto
// their own lines — a definition is meant to read as one short paragraph.
export function DefinitionText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`glossary-definition${streaming ? " is-streaming" : ""}`}>
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
    <span className={`glossary-source glossary-source--${source}`} title={title}>
      {label}
    </span>
  );
}
