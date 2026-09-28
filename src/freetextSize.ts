// Estimates a sticky note's size from its text, for the note's stored
// boundingRect (used to scroll to it, outline it and export it). The note on
// screen doesn't use this: App.css sizes it from its text directly, at any
// zoom. Keep the limits/padding here in step with those rules.
//
// Measured with a hidden, absolutely-positioned div (shrink-to-fit width,
// same wrapping rules as the library's own .FreetextHighlight__text: pre-wrap
// + break-word) rather than canvas measureText, so multi-line wrapping comes
// out the same as the real note.
export const FREETEXT_DEFAULT_FONT_FAMILY =
  '"Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Matches the sticker's .FreetextHighlight__content padding/line-height in
// App.css.
const PADDING_X = 12;
const PADDING_Y = 10;
export const FREETEXT_LINE_HEIGHT = "1.4";
const MAX_WIDTH = 240;
const MIN_WIDTH = 24;
const MIN_HEIGHT = 20;

let measurer: HTMLDivElement | null = null;

function getMeasurer(): HTMLDivElement {
  if (measurer) return measurer;
  const el = document.createElement("div");
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  el.style.pointerEvents = "none";
  el.style.top = "-9999px";
  el.style.left = "-9999px";
  el.style.whiteSpace = "pre-wrap";
  el.style.wordWrap = "break-word";
  el.style.overflowWrap = "break-word";
  document.body.appendChild(el);
  measurer = el;
  return el;
}

export function measureFreetextSize(
  text: string,
  fontSize?: string,
  fontFamily?: string,
): { width: number; height: number } {
  const el = getMeasurer();
  el.style.fontSize = fontSize || "14px";
  el.style.lineHeight = FREETEXT_LINE_HEIGHT;
  el.style.fontFamily = !fontFamily || fontFamily === "inherit" ? FREETEXT_DEFAULT_FONT_FAMILY : fontFamily;
  el.style.maxWidth = `${MAX_WIDTH}px`;
  el.style.width = "";
  el.textContent = text && text.length > 0 ? text : "New note";
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, el.scrollWidth));
  const height = Math.max(MIN_HEIGHT, el.scrollHeight);
  return {
    width: width + PADDING_X * 2,
    height: height + PADDING_Y * 2,
  };
}
