import { useMemo } from "react";
import ReactMarkdown, { type Components, type Options as MarkdownOptions } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMathNotation } from "../deepdive/mathNotation";
import { rehypeEquationBlocks } from "../deepdive/rehypeEquationBlocks";
import { chipLabel, decodeChipTarget, toChipMarkdown, trimPartialMarker } from "./citations";
import CitationChip, { type ResolvedRef } from "./CitationChip";
import type { SourceRef } from "./types";

const REMARK_PLUGINS: MarkdownOptions["remarkPlugins"] = [remarkGfm, remarkMath];
// The same pipeline as a Deep Dive turn (DivePanelPane's TurnMarkdown), and
// the same math styling (App.css), so equations look alike in both.
const REHYPE_PLUGINS: MarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
  rehypeEquationBlocks,
];

// A grounded answer outside Deep Dive (the Ask panel): markdown with math,
// its citation markers turned into chips. Deep Dive renders its own turns
// (DivePanelPane), which also carry the reader's highlights.
export default function AnswerMarkdown({
  content,
  sources,
  pageLabel,
  onJump,
  streaming = false,
}: {
  content: string;
  sources: SourceRef[];
  pageLabel: (pageNumber: number) => string;
  onJump: (ref: ResolvedRef) => void;
  streaming?: boolean;
}) {
  const components = useMemo<Components>(() => {
    const byLabel = new Map(sources.map((source) => [source.label, source]));
    return {
      a: ({ href, title, children }) => {
        const target = href ? decodeChipTarget(href) : null;
        if (!target) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        const refs = target.refs.flatMap(({ label, start, end }): ResolvedRef[] => {
          const source = byLabel.get(label);
          return source ? [{ source, range: [start, end] }] : [];
        });
        return (
          <CitationChip
            kind={target.kind}
            quoteMissing={target.quoteMissing}
            label={title ?? chipLabel(target.kind, refs.map((ref) => pageLabel(ref.source.pageNumber)))}
            refs={refs}
            pageLabel={pageLabel}
            onJump={onJump}
          />
        );
      },
    };
  }, [sources, pageLabel, onJump]);

  const text = streaming ? trimPartialMarker(content) : content;
  const markdown = toChipMarkdown(normalizeMathNotation(text, { promote: true }), sources, 0, pageLabel);
  return (
    <div className="answer-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
