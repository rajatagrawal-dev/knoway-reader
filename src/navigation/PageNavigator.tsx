import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Redo2, Undo2 } from "lucide-react";
import { usePopover } from "../components/usePopover";
import { formatPageLabel, pageNumberForInput } from "../pageLabels";
import type { ReadingPlace } from "./history";

// How long the control stays up after the reader last scrolled or turned a
// page.
const IDLE_HIDE_MS = 1500;

// How close the pointer has to come to the (hidden) control to bring it up.
const REVEAL_MARGIN_PX = 16;

interface PageNavigatorProps {
  currentPage: number;
  numPages: number;
  pageLabels: string[] | null;
  twoPageView: boolean;
  // Nearest first: the first is where one step goes.
  back: ReadingPlace[];
  forward: ReadingPlace[];
  onBack: (steps: number) => void;
  onForward: (steps: number) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onGoToPage: (pageNumber: number) => void;
  // Bumped by ⌥⌘G: put the cursor in the page number.
  focusRequest: number;
}

// Where the reader is in the document, and the ways to move: the previous
// or next page, a typed page number, and Back/Forward over earlier jumps.
// Floats at the bottom of the PDF pane (so it follows the pane into Deep
// Dive), shown while the reader scrolls or turns pages and faded out a
// moment after.
export default function PageNavigator({
  currentPage,
  numPages,
  pageLabels,
  twoPageView,
  back,
  forward,
  onBack,
  onForward,
  onPreviousPage,
  onNextPage,
  onGoToPage,
  focusRequest,
}: PageNavigatorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const [near, setNear] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const menu = usePopover();

  const idleTimerRef = useRef<number | undefined>(undefined);
  const reveal = () => {
    setActive(true);
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => setActive(false), IDLE_HIDE_MS);
  };
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => () => window.clearTimeout(idleTimerRef.current), []);

  // Scrolling anywhere in the pane (scroll events don't bubble, but they do
  // pass through the capture phase), the pointer coming near, and a drag
  // on a page — hidden then, so it never sits over a selection being made
  // (a drag on the scrollbar isn't on a page, and keeps it up).
  useEffect(() => {
    const pane = rootRef.current?.parentElement;
    if (!pane) return;
    const handleScroll = () => revealRef.current();
    const handleMouseMove = (event: MouseEvent) => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setNear(
        event.clientX >= rect.left - REVEAL_MARGIN_PX &&
          event.clientX <= rect.right + REVEAL_MARGIN_PX &&
          event.clientY >= rect.top - REVEAL_MARGIN_PX &&
          event.clientY <= rect.bottom + REVEAL_MARGIN_PX,
      );
    };
    const handleMouseLeave = () => setNear(false);
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 0 && (event.target as Element).closest?.(".page")) setDragging(true);
    };
    const handlePointerUp = () => setDragging(false);
    pane.addEventListener("scroll", handleScroll, { capture: true, passive: true });
    pane.addEventListener("wheel", handleScroll, { passive: true });
    pane.addEventListener("mousemove", handleMouseMove);
    pane.addEventListener("mouseleave", handleMouseLeave);
    pane.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      pane.removeEventListener("scroll", handleScroll, { capture: true });
      pane.removeEventListener("wheel", handleScroll);
      pane.removeEventListener("mousemove", handleMouseMove);
      pane.removeEventListener("mouseleave", handleMouseLeave);
      pane.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, []);

  // A page turned by keyboard, or reached by a jump.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    revealRef.current();
  }, [currentPage]);

  // Not while the PDF is parked out of sight in Deep Dive.
  useEffect(() => {
    if (!focusRequest || rootRef.current?.closest(".pdf-pane-offscreen-host")) return;
    revealRef.current();
    inputRef.current?.focus();
  }, [focusRequest]);

  // In two-page view pdf.js pairs pages 1–2, 3–4, …
  const firstShown = twoPageView && currentPage % 2 === 0 ? currentPage - 1 : currentPage;
  const lastShown = twoPageView ? Math.min(firstShown + 1, numPages) : firstShown;
  const label = formatPageLabel(pageLabels, firstShown);
  const labelled = Boolean(pageLabels) && label !== String(firstShown);
  const range = lastShown > firstShown ? `${firstShown}–${lastShown}` : String(firstShown);
  const total = labelled ? `(${range} / ${numPages})` : `${lastShown > firstShown ? `–${lastShown} ` : ""}/ ${numPages}`;

  // Wide enough for the longest label, so the control doesn't change width
  // from page to page.
  const inputChars = useMemo(() => {
    const longest = pageLabels ? Math.max(...pageLabels.map((l) => l.length)) : 0;
    return Math.max(2, longest, String(numPages).length);
  }, [pageLabels, numPages]);

  const submit = () => {
    const pageNumber = pageNumberForInput(pageLabels, draft ?? "", numPages);
    if (pageNumber === null) {
      setInvalid(true);
      return;
    }
    onGoToPage(pageNumber);
    inputRef.current?.blur();
  };

  const placeLabel = (place: ReadingPlace) => `p. ${formatPageLabel(pageLabels, place.pageNumber)}`;
  const hasHistory = back.length > 0 || forward.length > 0;
  const visible = !dragging && (active || near || focused || menu.open);

  return (
    <div
      ref={rootRef}
      className={`page-nav${visible ? " page-nav--visible" : ""}`}
      role="toolbar"
      aria-label="Page navigation"
      // Kept up while typing a page number or moving through it by keyboard
      // — not just because a button clicked with the mouse kept the focus.
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node)) setFocused(false);
      }}
    >
      {hasHistory ? (
        <>
          <button
            type="button"
            className="page-nav-button"
            onClick={() => onBack(1)}
            disabled={back.length === 0}
            title={back.length > 0 ? `Back to ${placeLabel(back[0])} (⌘←)` : "Back (⌘←)"}
            aria-label={back.length > 0 ? `Back to ${placeLabel(back[0])}` : "Back"}
          >
            <Undo2 width={14} height={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="page-nav-button"
            onClick={() => onForward(1)}
            disabled={forward.length === 0}
            title={forward.length > 0 ? `Forward to ${placeLabel(forward[0])} (⌘→)` : "Forward (⌘→)"}
            aria-label={forward.length > 0 ? `Forward to ${placeLabel(forward[0])}` : "Forward"}
          >
            <Redo2 width={14} height={14} aria-hidden="true" />
          </button>
          <div className="page-nav-anchor" ref={menu.ref}>
            <button
              type="button"
              className={`page-nav-button page-nav-caret${menu.open ? " active" : ""}`}
              onClick={() => menu.setOpen((open) => !open)}
              title="Places you've jumped between"
              aria-label="Places you've jumped between"
              aria-haspopup="menu"
              aria-expanded={menu.open}
            >
              <ChevronDown width={14} height={14} aria-hidden="true" />
            </button>
            {menu.open ? (
              <div className="page-nav-menu" role="menu">
                {[...forward].reverse().map((place, index) => (
                  <button
                    key={`forward-${index}`}
                    type="button"
                    role="menuitem"
                    className="page-nav-menu-item"
                    onClick={() => {
                      menu.setOpen(false);
                      onForward(forward.length - index);
                    }}
                  >
                    <Redo2 width={12} height={12} aria-hidden="true" />
                    {placeLabel(place)}
                  </button>
                ))}
                <div className="page-nav-menu-item page-nav-menu-current" aria-current="location">
                  <span className="page-nav-menu-dot" aria-hidden="true" />
                  p. {formatPageLabel(pageLabels, currentPage)} · here
                </div>
                {back.map((place, index) => (
                  <button
                    key={`back-${index}`}
                    type="button"
                    role="menuitem"
                    className="page-nav-menu-item"
                    onClick={() => {
                      menu.setOpen(false);
                      onBack(index + 1);
                    }}
                  >
                    <Undo2 width={12} height={12} aria-hidden="true" />
                    {placeLabel(place)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="page-nav-divider" role="separator" />
        </>
      ) : null}
      <button
        type="button"
        className="page-nav-button"
        onClick={onPreviousPage}
        disabled={firstShown <= 1}
        title="Previous page (←)"
        aria-label="Previous page"
      >
        <ChevronLeft width={16} height={16} aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        className="page-nav-input"
        style={{ width: `calc(${inputChars}ch + 12px)` }}
        value={draft ?? label}
        aria-label="Page number"
        aria-invalid={invalid}
        title="Go to page (⌥⌘G)"
        inputMode="text"
        spellCheck={false}
        autoComplete="off"
        onFocus={(event) => {
          setDraft(label);
          event.target.select();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            inputRef.current?.blur();
          }
        }}
        onBlur={() => {
          setDraft(null);
          setInvalid(false);
        }}
      />
      <span className="page-nav-total">{total}</span>
      <button
        type="button"
        className="page-nav-button"
        onClick={onNextPage}
        disabled={lastShown >= numPages}
        title="Next page (→)"
        aria-label="Next page"
      >
        <ChevronRight width={16} height={16} aria-hidden="true" />
      </button>
    </div>
  );
}
