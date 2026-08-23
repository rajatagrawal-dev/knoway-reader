import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { PdfHighlighterUtils } from "react-pdf-highlighter-plus";

interface MatchesCount {
  current: number;
  total: number;
}

// react-pdf-highlighter-plus wires PDF.js's own PDFFindController underneath
// search()/findNext()/findPrevious(), so its event bus (from getEventBus())
// emits PDF.js's standard "updatefindmatchescount"/"updatefindcontrolstate"
// events. Neither the library nor its typings re-export FindState, so these
// mirror pdf.js's internal enum (web/pdf_viewer.mjs) by value.
const FIND_STATE_NOT_FOUND = 1;

interface EventBusLike {
  on: (event: string, callback: (evt: any) => void) => void;
  off: (event: string, callback: (evt: any) => void) => void;
}

interface SearchBarProps {
  utilsRef: RefObject<PdfHighlighterUtils | null>;
  onClose: () => void;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "up" | "down" }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === "up" ? "18 15 12 9 6 15" : "6 9 12 15 18 9"} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export function SearchToggleButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title="Search (Ctrl+F)" aria-label="Search">
      <SearchIcon />
    </button>
  );
}

export default function SearchBar({ utilsRef, onClose }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<MatchesCount>({ current: 0, total: 0 });
  const [notFound, setNotFound] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<number>();
  const attachedBusRef = useRef<EventBusLike | null>(null);
  const handlersRef = useRef<{ onMatches: (evt: any) => void; onState: (evt: any) => void } | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // The PdfHighlighter (and its internal PDFFindController/event bus) remounts
  // whenever the app switches between the normal layout and Deep Dive split
  // view, so listeners are (re-)attached lazily, right before each action,
  // rather than once on mount.
  const ensureListeners = () => {
    const bus = utilsRef.current?.getEventBus() as EventBusLike | null | undefined;
    if (!bus || bus === attachedBusRef.current) return;
    if (attachedBusRef.current && handlersRef.current) {
      attachedBusRef.current.off("updatefindmatchescount", handlersRef.current.onMatches);
      attachedBusRef.current.off("updatefindcontrolstate", handlersRef.current.onState);
    }
    const onMatches = (evt: { matchesCount: MatchesCount }) => setMatches(evt.matchesCount);
    const onState = (evt: { state: number; matchesCount: MatchesCount }) => {
      setMatches(evt.matchesCount);
      setNotFound(evt.state === FIND_STATE_NOT_FOUND);
    };
    bus.on("updatefindmatchescount", onMatches);
    bus.on("updatefindcontrolstate", onState);
    handlersRef.current = { onMatches, onState };
    attachedBusRef.current = bus;
  };

  useEffect(() => {
    return () => {
      window.clearTimeout(debounceRef.current);
      utilsRef.current?.clearSearch();
      if (attachedBusRef.current && handlersRef.current) {
        attachedBusRef.current.off("updatefindmatchescount", handlersRef.current.onMatches);
        attachedBusRef.current.off("updatefindcontrolstate", handlersRef.current.onState);
      }
    };
  }, [utilsRef]);

  const runSearch = (value: string) => {
    ensureListeners();
    utilsRef.current?.search(value, { highlightAll: true });
  };

  const handleChange = (value: string) => {
    setQuery(value);
    if (!value.trim()) {
      setMatches({ current: 0, total: 0 });
      setNotFound(false);
    }
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => runSearch(value), 250);
  };

  const handleNext = () => {
    ensureListeners();
    utilsRef.current?.findNext();
  };

  const handlePrevious = () => {
    ensureListeners();
    utilsRef.current?.findPrevious();
  };

  const handleClose = () => {
    window.clearTimeout(debounceRef.current);
    utilsRef.current?.clearSearch();
    setQuery("");
    setMatches({ current: 0, total: 0 });
    setNotFound(false);
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) {
        handlePrevious();
      } else {
        handleNext();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      handleClose();
    }
  };

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Search in document"
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="search-bar-count">
        {query.trim() ? (matches.total > 0 ? `${matches.current} / ${matches.total}` : notFound ? "No results" : "") : ""}
      </span>
      <button
        type="button"
        onClick={handlePrevious}
        disabled={matches.total === 0}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
      >
        <ChevronIcon direction="up" />
      </button>
      <button
        type="button"
        onClick={handleNext}
        disabled={matches.total === 0}
        title="Next match (Enter)"
        aria-label="Next match"
      >
        <ChevronIcon direction="down" />
      </button>
      <button type="button" onClick={handleClose} title="Close (Esc)" aria-label="Close search">
        <CloseIcon />
      </button>
    </div>
  );
}
