import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { PdfHighlighterUtils } from "react-pdf-highlighter-plus";
import PdfPane, { type PdfPaneProps } from "./PdfPane";

export type DockTarget = "workspace" | "deep-dive-root" | "offscreen";

// Mirrors the retry window PdfPane.tsx uses for its own mount-time
// corrective scrolls: pdf.js reports "settled" once its currentPageNumber
// counter matches the target, but that counter updates before the actual
// scroll — which depends on every earlier page's real, measured height —
// has necessarily landed. Re-issuing the same command over this window
// gives it time to finish measuring and self-correct on a later call.
//
// The very first correction is handled separately (synchronously, then
// chased across a couple of animation frames — see EARLY_CORRECTION_FRAMES)
// so the reparented pane never gets painted at the wrong position even for
// one frame; these later ticks are only for the slower settling that
// happens once pdf.js finishes measuring pages it hasn't rendered yet.
const CORRECTION_DELAYS_MS = [300, 800, 1500, 3000, 5000];

// pdf.js reacts to the container swap with its own ResizeObserver, which can
// rescale/re-settle its idea of the current page within the same or next
// frame — after our synchronous correction has already run. Chasing it for
// a couple of animation frames (still before the browser paints) makes sure
// that async rescale doesn't get the last word and flash the wrong spot.
const EARLY_CORRECTION_FRAMES = 3;

// Once the user actually scrolls, that's their intent now, not ours —
// keep correcting past that point and every later tick fights their input,
// which is exactly what reads as the view "resetting" under them.
const USER_INTERACTION_EVENTS = ["wheel", "touchstart", "pointerdown"] as const;

interface ScrollIntent {
  pageNumber: number;
  // Fraction of the target page's own height, not the whole document's —
  // deliberately local to that one page. A document-wide scrollTop/
  // scrollHeight fraction is unreliable exactly when it matters most
  // (landing on a page that hasn't been visited/measured yet, where far-away
  // pages are still using placeholder height estimates); the target page
  // itself, once scrolled near, is reliably measured.
  localFraction: number;
}

function capturePageElement(scrollEl: Element, pageNumber: number): HTMLElement | null {
  return scrollEl.querySelector<HTMLElement>(`.page[data-page-number="${pageNumber}"]`);
}

function captureScrollIntent(scrollEl: HTMLElement, pageNumber: number): ScrollIntent {
  const pageEl = capturePageElement(scrollEl, pageNumber);
  if (!pageEl || pageEl.offsetHeight <= 0) return { pageNumber, localFraction: 0 };
  const pageTop =
    pageEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  const localFraction = (scrollEl.scrollTop - pageTop) / pageEl.offsetHeight;
  return { pageNumber, localFraction: Math.max(0, Math.min(1, localFraction)) };
}

function applyScrollIntent(scrollEl: HTMLElement, intent: ScrollIntent) {
  const pageEl = capturePageElement(scrollEl, intent.pageNumber);
  if (!pageEl) return;
  const pageTop =
    pageEl.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop;
  scrollEl.scrollTop = pageTop + intent.localFraction * pageEl.offsetHeight;
}

// The main document's PdfPane is rendered exactly once here for the whole
// session — this component's own position in the tree never changes, so
// React never unmounts the PdfPane/PdfHighlighter/pdf.js PDFViewer it holds.
// Instead of remounting on every workspace <-> Deep Dive transition, its
// rendered DOM is reparented (via plain appendChild, which preserves
// scrollTop) into whichever slot is currently visible.
export default function PersistentPdfPane({
  pdfPaneProps,
  dockTarget,
  workspaceSlotRef,
  deepDiveRootSlotRef,
  highlighterUtilsRef,
}: {
  pdfPaneProps: PdfPaneProps;
  dockTarget: DockTarget;
  workspaceSlotRef: RefObject<HTMLDivElement>;
  deepDiveRootSlotRef: RefObject<HTMLDivElement>;
  highlighterUtilsRef: RefObject<PdfHighlighterUtils | null>;
}) {
  const paneHostRef = useRef<HTMLDivElement | null>(null);
  if (!paneHostRef.current) {
    const el = document.createElement("div");
    el.className = "pdf-pane-host";
    paneHostRef.current = el;
  }

  const offscreenHostRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const host = paneHostRef.current;
    if (!host) return;

    let target: HTMLDivElement | null;
    if (dockTarget === "workspace") {
      target = workspaceSlotRef.current;
    } else if (dockTarget === "deep-dive-root") {
      target = deepDiveRootSlotRef.current;
    } else {
      if (!offscreenHostRef.current) {
        const el = document.createElement("div");
        el.className = "pdf-pane-offscreen-host";
        document.body.appendChild(el);
        offscreenHostRef.current = el;
      }
      target = offscreenHostRef.current;
    }

    if (target && host.parentNode !== target) {
      // pdf.js rescales to fit its new container on every resize (via its
      // own ResizeObserver), which is normally where the split-view <->
      // workspace width change gets its proportional scroll position for
      // free. But coming back from a pane that was parked off in the
      // keep-alive container — or landing on a page whose real height
      // hasn't been measured yet — that rescale can land pdf.js's own
      // notion of "current page" on the wrong spot, including snapping all
      // the way back to the first page. Capture where we actually are
      // (page + position within it) before moving, and keep reapplying it
      // over a window afterward, so the visible position ends up right
      // regardless of what pdf.js's own resize handling computed — same
      // rationale as the mount-time corrective scrolls in PdfPane.tsx.
      const scrollEl = host.querySelector<HTMLElement>(".PdfHighlighter");
      const viewer = highlighterUtilsRef.current?.getViewer();
      const pageNumber = viewer?.currentPageNumber;
      const intent = scrollEl && pageNumber ? captureScrollIntent(scrollEl, pageNumber) : null;

      target.appendChild(host);

      if (!intent) return;

      let stopped = false;
      const applyCorrection = () => {
        if (stopped) return;
        try {
          highlighterUtilsRef.current?.getViewer()?.scrollPageIntoView({ pageNumber: intent.pageNumber });
          const el = host.querySelector<HTMLElement>(".PdfHighlighter");
          if (el) applyScrollIntent(el, intent);
        } catch {
          // best-effort correction; nothing to do if it throws
        }
      };

      // Run before this commit paints, so the reparented pane is never
      // shown even for one frame at whatever spot pdf.js's own resize
      // handling landed on.
      applyCorrection();

      const rafIds: number[] = [];
      let framesLeft = EARLY_CORRECTION_FRAMES;
      const chaseFrame = () => {
        applyCorrection();
        framesLeft -= 1;
        if (framesLeft > 0) rafIds.push(requestAnimationFrame(chaseFrame));
      };
      rafIds.push(requestAnimationFrame(chaseFrame));

      const timeoutIds = CORRECTION_DELAYS_MS.map((delay) => window.setTimeout(applyCorrection, delay));

      const stopCorrecting = () => {
        stopped = true;
        rafIds.forEach(cancelAnimationFrame);
        timeoutIds.forEach(window.clearTimeout);
      };
      USER_INTERACTION_EVENTS.forEach((evt) =>
        scrollEl?.addEventListener(evt, stopCorrecting, { passive: true, once: true }),
      );

      return () => {
        stopCorrecting();
        USER_INTERACTION_EVENTS.forEach((evt) => scrollEl?.removeEventListener(evt, stopCorrecting));
      };
    }
  }, [dockTarget, workspaceSlotRef, deepDiveRootSlotRef, highlighterUtilsRef]);

  useLayoutEffect(() => {
    return () => {
      offscreenHostRef.current?.remove();
      offscreenHostRef.current = null;
    };
  }, []);

  return createPortal(<PdfPane {...pdfPaneProps} />, paneHostRef.current);
}
