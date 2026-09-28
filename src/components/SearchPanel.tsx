import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ScaledPosition } from "react-pdf-highlighter-plus";
import { getTextIndex } from "../glossary/job";
import { findTextMatches, matchId, matchPosition, snippetAround, type DocumentTextIndex } from "../glossary/textIndex";
import { formatPageLabel } from "../pageLabels";

export interface SearchMatch {
  id: string;
  pageNumber: number;
  before: string;
  match: string;
  after: string;
  position: ScaledPosition;
}

interface SearchPanelProps {
  pdfDocument: PDFDocumentProxy | null;
  pageLabels: string[] | null;
  // Kept by App so the query survives switching to another panel and back.
  query: string;
  onQueryChange: (query: string) => void;
  // Bumped by ⌘F: focuses (and selects) the input even if already open.
  focusRequest: number;
  onJumpToMatch: (match: SearchMatch) => void;
}

// Results rendered at most — a one-letter query in a long book can match
// tens of thousands of times.
const MAX_RESULTS = 500;
// Enough context to fill the row's two clamped lines around the match.
const SNIPPET_RADIUS = 45;
const SEARCH_DEBOUNCE_MS = 200;

export default function SearchPanel({
  pdfDocument,
  pageLabels,
  query,
  onQueryChange,
  focusRequest,
  onJumpToMatch,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState<DocumentTextIndex | null>(null);
  const [indexError, setIndexError] = useState(false);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);

  // The same whole-document text index glossary lookups use (built once
  // per document, and usually already warm by the time search opens).
  useEffect(() => {
    if (!pdfDocument) return;
    let cancelled = false;
    setIndexError(false);
    getTextIndex(pdfDocument)
      .then((built) => {
        if (!cancelled) setIndex(built);
      })
      .catch(() => {
        if (!cancelled) setIndexError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const { results, total } = useMemo(() => {
    if (!index) return { results: [] as SearchMatch[], total: 0 };
    const matches = findTextMatches(index, debouncedQuery);
    const shown: SearchMatch[] = [];
    for (const match of matches.slice(0, MAX_RESULTS)) {
      const position = matchPosition(match);
      if (!position) continue;
      shown.push({ id: matchId(match), pageNumber: match.page.pageNumber, position, ...snippetAround(match, SNIPPET_RADIUS) });
    }
    return { results: shown, total: matches.length };
  }, [index, debouncedQuery]);

  useEffect(() => setActiveIndex(null), [results]);

  useEffect(() => {
    if (activeIndex === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-result-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const jumpTo = (resultIndex: number) => {
    const result = results[resultIndex];
    if (!result) return;
    setActiveIndex(resultIndex);
    onJumpToMatch(result);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || results.length === 0) return;
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const next =
      activeIndex === null
        ? event.shiftKey
          ? results.length - 1
          : 0
        : (activeIndex + step + results.length) % results.length;
    jumpTo(next);
  };

  // Consecutive results on one page share a heading instead of each
  // repeating the page number.
  const groups = useMemo(() => {
    const byPage: { pageNumber: number; items: { result: SearchMatch; resultIndex: number }[] }[] = [];
    results.forEach((result, resultIndex) => {
      const last = byPage[byPage.length - 1];
      const item = { result, resultIndex };
      if (last?.pageNumber === result.pageNumber) last.items.push(item);
      else byPage.push({ pageNumber: result.pageNumber, items: [item] });
    });
    return byPage;
  }, [results]);

  const trimmed = debouncedQuery.trim();
  let status: string;
  if (indexError) status = "Couldn't read this document's text.";
  else if (!index) status = "Reading document text…";
  else if (!trimmed) status = "Type to search the whole document.";
  else if (total === 0) status = "No results";
  else if (total > results.length) status = `${total} results (showing the first ${results.length})`;
  else status = `${total} result${total === 1 ? "" : "s"}`;

  return (
    <>
      <header className="sidebar-header">
        <h2>Search</h2>
        <div className="search-field">
          <Search className="search-field-icon" width={15} height={15} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search in document"
            aria-label="Search in document"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          {query ? (
            <button
              type="button"
              className="search-field-clear"
              title="Clear"
              aria-label="Clear search"
              onClick={() => {
                onQueryChange("");
                inputRef.current?.focus();
              }}
            >
              <X width={14} height={14} />
            </button>
          ) : null}
        </div>
        <p className="search-panel-status" aria-live="polite">
          {status}
          {activeIndex !== null ? ` · ${activeIndex + 1} of ${results.length}` : ""}
        </p>
      </header>
      <div className="sidebar-list search-results" ref={listRef}>
        {groups.map((group) => (
          <section key={`${group.pageNumber}-${group.items[0].resultIndex}`}>
            <h3 className="search-group-heading">
              <span>Page {formatPageLabel(pageLabels, group.pageNumber)}</span>
              <span className="search-group-count">{group.items.length}</span>
            </h3>
            {group.items.map(({ result, resultIndex }) => (
              <button
                key={result.id}
                type="button"
                data-result-index={resultIndex}
                className={`search-result${activeIndex === resultIndex ? " is-active" : ""}`}
                onClick={() => jumpTo(resultIndex)}
              >
                <span className="search-result-snippet">
                  {result.before}
                  <mark>{result.match}</mark>
                  {result.after}
                </span>
              </button>
            ))}
          </section>
        ))}
        {trimmed && index && total === 0 ? (
          <p className="search-empty">Page headers and footers aren't searched.</p>
        ) : null}
      </div>
    </>
  );
}
