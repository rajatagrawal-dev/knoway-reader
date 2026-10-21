import { useEffect, useRef, useState } from "react";
import { Globe, X } from "lucide-react";
import type { DocumentMeta, LibraryStorage } from "../storage/types.ts";
import { WebImportError, type ImportProgress, type ImportReport } from "./types.ts";
import { parseUserUrl } from "./url.ts";

// "Add from URL": asks for an address, shows the import's progress, and
// says plainly what couldn't be kept exactly as it was on the page (a
// picture that wouldn't download, a video saved as a link) before opening
// the result. When nothing was lost, the document opens straight away.

type State =
  | { kind: "form"; error?: string }
  | { kind: "working"; progress: ImportProgress }
  | { kind: "choosePdf"; title: string; pdfUrl: string }
  | { kind: "done"; meta: DocumentMeta; report: ImportReport }
  | { kind: "existing"; meta: DocumentMeta; unchanged: boolean };

function plural(count: number, word: string, plural = `${word}s`) {
  return `${count} ${count === 1 ? word : plural}`;
}

function stageLabel(progress: ImportProgress): string {
  const counted = progress.total ? ` ${Math.min(progress.done ?? 0, progress.total)} of ${progress.total}` : "";
  switch (progress.stage) {
    case "checking":
      return "Checking your library…";
    case "fetching":
      return "Fetching the page…";
    case "reading":
      return "Finding the article…";
    case "figures":
      return `Capturing figures…${counted}`;
    case "images":
      return `Saving pictures…${counted}`;
    case "layout":
      return "Laying out the pages…";
    case "saving":
      return "Adding it to your library…";
  }
}

// Anything the reader should hear about before reading.
function hasNotes(report: ImportReport): boolean {
  return (
    report.imagesFailed.length > 0 ||
    report.figuresFailed > 0 ||
    report.media.length > 0 ||
    report.mathAsTex > 0 ||
    report.warnings.length > 0
  );
}

function savedOn(meta: DocumentMeta): string {
  const date = meta.source?.fetchedAt ?? meta.addedAt;
  const time = Date.parse(date);
  return Number.isFinite(time) ? new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

const MEDIA_WORDS = { video: "video", audio: "audio clip", embed: "embedded item", code: "code embed" } as const;

function ReportList({ report }: { report: ImportReport }) {
  const media = Object.entries(
    report.media.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] ?? 0) + 1 }), {}),
  );
  return (
    <ul className="url-dialog-report">
      {report.imagesFailed.length > 0 ? (
        <li>
          {plural(report.imagesFailed.length, "picture")} couldn't be downloaded. A note with a link marks each one's place:
          <ul>
            {report.imagesFailed.slice(0, 6).map((image) => (
              <li key={image.url}>
                <a href={image.url} target="_blank" rel="noreferrer">
                  {image.alt || image.url.replace(/^https?:\/\//, "").slice(0, 80)}
                </a>
              </li>
            ))}
            {report.imagesFailed.length > 6 ? <li>…and {report.imagesFailed.length - 6} more</li> : null}
          </ul>
        </li>
      ) : null}
      {report.figuresFailed > 0 ? (
        <li>{plural(report.figuresFailed, "figure")} drawn by the page couldn't be captured as a picture, so its text was kept instead.</li>
      ) : null}
      {media.map(([kind, count]) => (
        <li key={kind}>
          {plural(count, MEDIA_WORDS[kind as keyof typeof MEDIA_WORDS])} {count === 1 ? "is" : "are"} saved as a link, since a PDF can't play {count === 1 ? "it" : "them"}.
        </li>
      ))}
      {report.mathAsTex > 0 ? <li>{plural(report.mathAsTex, "formula", "formulas")} {report.mathAsTex === 1 ? "is" : "are"} shown as TeX source.</li> : null}
      {report.warnings.map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  );
}

export default function AddFromUrlDialog({
  storage,
  initialUrl = "",
  autoStart = false,
  onClose,
  onOpen,
  onChanged,
}: {
  storage: LibraryStorage;
  initialUrl?: string;
  autoStart?: boolean;
  onClose: () => void;
  onOpen: (meta: DocumentMeta) => void;
  onChanged: () => void; // the library has a new document
}) {
  const [url, setUrl] = useState(initialUrl);
  const [state, setState] = useState<State>({ kind: "form" });
  const controllerRef = useRef<AbortController | null>(null);
  const pdfChoiceRef = useRef<((takePdf: boolean) => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const start = async (force = false) => {
    if (!parseUserUrl(url)) {
      setState({ kind: "form", error: "Enter a web address, like https://example.com/article." });
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ kind: "working", progress: { stage: "checking" } });
    try {
      const { addFromUrl } = await import("./index");
      const result = await addFromUrl(storage, url, {
        signal: controller.signal,
        force,
        onProgress: (progress) => {
          if (!controller.signal.aborted) setState({ kind: "working", progress });
        },
        choosePdf: (offer) =>
          new Promise<boolean>((resolve) => {
            pdfChoiceRef.current = resolve;
            setState({ kind: "choosePdf", title: offer.title, pdfUrl: offer.pdfUrl });
          }),
      });
      if (controller.signal.aborted) return;
      if (result.status === "existing") {
        setState({ kind: "existing", meta: result.meta, unchanged: result.unchanged === true });
        if (result.unchanged) onChanged();
        return;
      }
      onChanged();
      if (result.report && hasNotes(result.report)) setState({ kind: "done", meta: result.meta, report: result.report });
      else onOpen(result.meta);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
      if (!(error instanceof WebImportError)) console.error(error); // the others are explained to the reader
      setState({ kind: "form", error: error instanceof Error && error.message ? error.message : "Couldn't add that page." });
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    pdfChoiceRef.current = null;
    onClose();
  };

  useEffect(() => {
    if (autoStart && initialUrl) void start();
    else inputRef.current?.focus();
    return () => controllerRef.current?.abort();
    // Started once, for the address it opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const choosePdf = (takePdf: boolean) => {
    const resolve = pdfChoiceRef.current;
    pdfChoiceRef.current = null;
    setState({ kind: "working", progress: { stage: takePdf ? "fetching" : "reading" } });
    resolve?.(takePdf);
  };

  const fraction =
    state.kind === "working" && state.progress.total ? Math.min(1, (state.progress.done ?? 0) / state.progress.total) : null;

  return (
    <div className="url-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && state.kind !== "working" && cancel()}>
      <div className="url-dialog" role="dialog" aria-modal="true" aria-labelledby="url-dialog-title">
        <header className="url-dialog-header">
          <Globe width={16} height={16} aria-hidden="true" />
          <h2 id="url-dialog-title">Add from URL</h2>
          <button type="button" className="library-icon-button" onClick={cancel} title="Close">
            <X width={16} height={16} />
          </button>
        </header>

        {state.kind === "form" ? (
          <form
            className="url-dialog-body"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <p className="url-dialog-hint">
              A blog post, an article, documentation, or a link to a PDF or EPUB. The page is saved as a document you can read
              and annotate offline.
            </p>
            <input
              ref={inputRef}
              className="url-dialog-input"
              type="text" // not "url": that rejects "example.com/post", which is fine here
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              spellCheck={false}
              autoComplete="off"
            />
            {state.error ? (
              <p className="url-dialog-error" role="alert">
                {state.error}
              </p>
            ) : null}
            <div className="url-dialog-actions">
              <button type="button" className="url-dialog-button" onClick={cancel}>
                Cancel
              </button>
              <button type="submit" className="url-dialog-button is-primary" disabled={!url.trim()}>
                Add
              </button>
            </div>
          </form>
        ) : state.kind === "working" ? (
          <div className="url-dialog-body">
            <p className="url-dialog-address">{url}</p>
            <p className="url-dialog-stage" role="status">
              {stageLabel(state.progress)}
            </p>
            <div className={`url-dialog-progress${fraction === null ? " is-indeterminate" : ""}`}>
              <span style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }} />
            </div>
            <div className="url-dialog-actions">
              <button type="button" className="url-dialog-button" onClick={cancel}>
                Cancel
              </button>
            </div>
          </div>
        ) : state.kind === "choosePdf" ? (
          <div className="url-dialog-body">
            <p>
              This page offers a PDF of <strong>{state.title}</strong>. The PDF is usually the better copy to study: it has the
              paper's own layout, equations and page numbers.
            </p>
            <p className="url-dialog-address">{state.pdfUrl}</p>
            <div className="url-dialog-actions">
              <button type="button" className="url-dialog-button" onClick={() => choosePdf(false)}>
                Save the web page
              </button>
              <button type="button" className="url-dialog-button is-primary" onClick={() => choosePdf(true)} autoFocus>
                Add the PDF
              </button>
            </div>
          </div>
        ) : state.kind === "existing" ? (
          <div className="url-dialog-body">
            <p>
              {state.unchanged ? (
                <>
                  <strong>{state.meta.title}</strong> hasn't changed since you saved it.
                </>
              ) : (
                <>
                  <strong>{state.meta.title}</strong> is already in your library{savedOn(state.meta) ? ` (saved ${savedOn(state.meta)})` : ""}.
                </>
              )}
            </p>
            <div className="url-dialog-actions">
              {state.unchanged ? null : (
                <button type="button" className="url-dialog-button" onClick={() => void start(true)} title="Fetch the page again and save it as a new document if it has changed">
                  Save a fresh copy
                </button>
              )}
              <button type="button" className="url-dialog-button is-primary" onClick={() => onOpen(state.meta)} autoFocus>
                Open
              </button>
            </div>
          </div>
        ) : (
          <div className="url-dialog-body">
            <p>
              Added <strong>{state.meta.title}</strong>
              {state.meta.pageCount ? ` (${plural(state.meta.pageCount, "page")})` : ""}. A few things couldn't be kept exactly as
              they were on the page:
            </p>
            <ReportList report={state.report} />
            <div className="url-dialog-actions">
              <button type="button" className="url-dialog-button" onClick={onClose}>
                Close
              </button>
              <button type="button" className="url-dialog-button is-primary" onClick={() => onOpen(state.meta)} autoFocus>
                Open
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
