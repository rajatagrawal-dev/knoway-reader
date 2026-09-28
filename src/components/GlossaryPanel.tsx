import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RotateCw, Star, Trash2 } from "lucide-react";
import { useGlossaryEntries, type GlossaryStore } from "../glossary/store";
import { DefinitionText, SourceBadge } from "../glossary/GlossaryParts";
import { lookupStatusText, refCountText } from "../glossary/format";
import type { GlossaryEntry, GlossaryRef } from "../glossary/types";
import { formatPageLabel } from "../pageLabels";

export interface GlossaryFocusRequest {
  entryId: string;
  nonce: number; // re-focusing the same entry is still a new request
}

interface GlossaryPanelProps {
  store: GlossaryStore;
  pageLabels: string[] | null;
  focusRequest: GlossaryFocusRequest | null;
  onJumpToRef: (ref: GlossaryRef) => void;
  onRetry: (entryId: string) => void;
  onDelete: (entryId: string) => void;
  marksVisible: boolean;
  onMarksVisibleChange: (visible: boolean) => void;
}

type SortKey = "recent" | "alpha" | "page";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "Recently added",
  alpha: "A–Z",
  page: "Page order",
};

const SORTERS: Record<SortKey, (a: GlossaryEntry, b: GlossaryEntry) => number> = {
  recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
  alpha: (a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: "base" }),
  page: (a, b) => (a.refs[0]?.pageNumber ?? a.pageNumber) - (b.refs[0]?.pageNumber ?? b.pageNumber),
};

// References shown before "Show all" — a common term can have hundreds.
const INITIAL_REFS = 20;

function RefRow({
  glossaryRef,
  isDefinition,
  isActive,
  pageLabels,
  onJump,
}: {
  glossaryRef: GlossaryRef;
  isDefinition: boolean;
  isActive: boolean;
  pageLabels: string[] | null;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      className={`glossary-ref${isActive ? " is-active" : ""}${isDefinition ? " is-definition" : ""}`}
      onClick={onJump}
      title={isDefinition ? "Where the document defines this term" : undefined}
    >
      <span className="glossary-ref-page">
        {isDefinition ? <Star width={10} height={10} fill="currentColor" /> : null}
        p. {formatPageLabel(pageLabels, glossaryRef.pageNumber)}
      </span>
      <span className="glossary-ref-snippet">
        {glossaryRef.before}
        <mark>{glossaryRef.match}</mark>
        {glossaryRef.after}
      </span>
    </button>
  );
}

function GlossaryEntryItem({
  entry,
  expanded,
  onToggle,
  pageLabels,
  activeRefId,
  onJumpToRef,
  onRetry,
  onDelete,
  itemRef,
}: {
  entry: GlossaryEntry;
  expanded: boolean;
  onToggle: () => void;
  pageLabels: string[] | null;
  activeRefId: string | null; // `${entryId}:${refId}` — ref ids are only unique per entry
  onJumpToRef: (ref: GlossaryRef) => void;
  onRetry: () => void;
  onDelete: () => void;
  itemRef: (element: HTMLDivElement | null) => void;
}) {
  const [showAllRefs, setShowAllRefs] = useState(false);
  const busy = entry.status === "pending" || entry.status === "streaming";
  const definitionRef = entry.definedRefId ? entry.refs.find((ref) => ref.id === entry.definedRefId) : undefined;
  const visibleRefs = showAllRefs ? entry.refs : entry.refs.slice(0, INITIAL_REFS);

  return (
    <div className={`glossary-entry${expanded ? " is-expanded" : ""}`} ref={itemRef}>
      <div className="glossary-entry-top">
        <button type="button" className="glossary-entry-head" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? <ChevronDown width={13} height={13} /> : <ChevronRight width={13} height={13} />}
          <span className="glossary-entry-term">{entry.term}</span>
          <SourceBadge source={entry.source} />
        </button>
        <div className="sidebar-item-actions">
          <button
            type="button"
            className="sidebar-item-action"
            title="Look up again"
            aria-label="Look up again"
            disabled={busy}
            onClick={onRetry}
          >
            <RotateCw width={13} height={13} />
          </button>
          <button
            type="button"
            className="sidebar-item-action sidebar-item-delete"
            title="Remove from glossary"
            aria-label="Remove from glossary"
            onClick={onDelete}
          >
            <Trash2 width={13} height={13} />
          </button>
        </div>
      </div>

      <div className={`glossary-entry-body${expanded ? "" : " is-collapsed"}`} onClick={expanded ? undefined : onToggle}>
        {entry.status === "error" ? (
          <p className="glossary-entry-error">
            {entry.error}{" "}
            <button type="button" className="glossary-card-link" onClick={onRetry}>
              Retry
            </button>
          </p>
        ) : busy && !entry.definition ? (
          <p className="glossary-card-status">
            <span className="glossary-spinner" aria-hidden="true" />
            {lookupStatusText(entry)}
          </p>
        ) : (
          <DefinitionText text={entry.definition} streaming={entry.status === "streaming"} />
        )}
      </div>

      {expanded ? (
        <div className="glossary-entry-details">
          {entry.aliases.length > 0 ? (
            <p className="glossary-entry-aliases">Also: {entry.aliases.join(", ")}</p>
          ) : null}
          {definitionRef ? (
            <button type="button" className="glossary-card-link" onClick={() => onJumpToRef(definitionRef)}>
              <Star width={11} height={11} fill="currentColor" /> Defined on p.{" "}
              {formatPageLabel(pageLabels, definitionRef.pageNumber)}
            </button>
          ) : null}

          <h3 className="glossary-refs-heading">
            {entry.refCount === 0 && !busy ? "No references found" : refCountText(entry.refCount)}
          </h3>
          {entry.refs.length > 0 ? (
            <div className="glossary-refs">
              {visibleRefs.map((ref) => (
                <RefRow
                  key={ref.id}
                  glossaryRef={ref}
                  isDefinition={ref.id === entry.definedRefId}
                  isActive={`${entry.id}:${ref.id}` === activeRefId}
                  pageLabels={pageLabels}
                  onJump={() => onJumpToRef(ref)}
                />
              ))}
            </div>
          ) : null}
          {entry.refs.length > INITIAL_REFS ? (
            <button type="button" className="glossary-card-link" onClick={() => setShowAllRefs((value) => !value)}>
              {showAllRefs ? "Show fewer" : `Show all ${entry.refs.length}`}
            </button>
          ) : null}
          {showAllRefs && entry.refCount > entry.refs.length ? (
            <p className="glossary-refs-note">
              Showing the first {entry.refs.length} of {entry.refCount}.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function GlossaryPanel({
  store,
  pageLabels,
  focusRequest,
  onJumpToRef,
  onRetry,
  onDelete,
  marksVisible,
  onMarksVisibleChange,
}: GlossaryPanelProps) {
  const entries = useGlossaryEntries(store);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [activeRefId, setActiveRefId] = useState<string | null>(null);
  const itemElements = useRef(new Map<string, HTMLDivElement>());

  // Opened from a definition card: expand that entry and bring it into view.
  useEffect(() => {
    if (!focusRequest) return;
    setQuery("");
    setExpandedIds((previous) => new Set(previous).add(focusRequest.entryId));
    requestAnimationFrame(() => {
      itemElements.current.get(focusRequest.entryId)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  }, [focusRequest]);

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? entries.filter(
          (entry) =>
            entry.term.toLowerCase().includes(needle) ||
            entry.aliases.some((alias) => alias.toLowerCase().includes(needle)) ||
            entry.definition.toLowerCase().includes(needle),
        )
      : entries;
    return [...filtered].sort(SORTERS[sort]);
  }, [entries, query, sort]);

  const toggle = (entryId: string) => {
    setExpandedIds((previous) => {
      const next = new Set(previous);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  return (
    <>
      <header className="sidebar-header">
        <h2>Glossary</h2>
        <p className="sidebar-count">
          {query.trim() ? `${visibleEntries.length} of ${entries.length}` : entries.length} term
          {entries.length === 1 ? "" : "s"}
        </p>
      </header>

      {entries.length > 0 ? (
        <div className="glossary-controls">
          <input
            type="search"
            className="quick-note-input"
            placeholder="Filter terms"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            className="glossary-sort"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            aria-label="Sort terms"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {entries.length > 0 ? (
        <label className="glossary-marks-toggle">
          <input type="checkbox" checked={marksVisible} onChange={(event) => onMarksVisibleChange(event.target.checked)} />
          Mark terms in the text
        </label>
      ) : null}

      <div className="sidebar-list">
        {entries.length === 0 ? (
          <div className="sidebar-empty">
            <p>No terms yet</p>
            <p className="sidebar-hint">
              Select a word or phrase in the PDF and choose Glossary. Its meaning, as this document uses it,
              appears right next to the selection and is saved here with links to everywhere it appears.
            </p>
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="sidebar-empty">
            <p>No terms match "{query.trim()}"</p>
          </div>
        ) : (
          visibleEntries.map((entry) => (
            <GlossaryEntryItem
              key={entry.id}
              entry={entry}
              expanded={expandedIds.has(entry.id)}
              onToggle={() => toggle(entry.id)}
              pageLabels={pageLabels}
              activeRefId={activeRefId}
              onJumpToRef={(ref) => {
                setActiveRefId(`${entry.id}:${ref.id}`);
                onJumpToRef(ref);
              }}
              onRetry={() => onRetry(entry.id)}
              onDelete={() => onDelete(entry.id)}
              itemRef={(element) => {
                if (element) itemElements.current.set(entry.id, element);
                else itemElements.current.delete(entry.id);
              }}
            />
          ))
        )}
      </div>
    </>
  );
}
