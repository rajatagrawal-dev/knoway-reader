// A chapter as the browser laid it out (layout.ts), ready to be paginated
// (paginate.ts) and drawn into the PDF (writePdf.ts). Everything is in CSS
// pixels from the chapter's top-left, in a column one page's text wide.

// The faces the book is set in: the browser lays it out in exactly these
// fonts, and the PDF embeds them, so every line breaks where it did on
// screen. Anything a face lacks comes from "fallback".
export type Face = "serif" | "serif-bold" | "serif-italic" | "serif-bold-italic" | "mono" | "mono-bold";
export type FontName = Face | "fallback";

export type Rgb = [number, number, number]; // 0–1

export interface TextRun {
  text: string; // as drawn: whitespace collapsed, text-transform applied
  left: number;
  top: number; // the line's text box (font ascent to descent)
  bottom: number;
  baseline: number;
  font: Face;
  size: number; // px
  color: Rgb;
  keepWithNext?: boolean; // part of a heading
  // Laid out and kept in the PDF as text — selectable, searchable, read by
  // Ask — but not drawn: the words of a picture, over the picture
  // (data-kr-invisible; see src/web/ for figures captured as images).
  invisible?: boolean;
}

export type ImageSource = { path: string } | { svg: string }; // a file in the book, or an inline <svg>

export interface ImageBox {
  source: ImageSource;
  left: number;
  top: number;
  width: number;
  height: number;
  // "contain": the picture keeps its proportions inside the box, centred (an
  // <svg> wrapping an <image>, as many covers are); otherwise it fills it.
  fit?: "contain";
}

// A background or border (table rules, a code block's shading, an <hr>).
export interface FilledBox {
  left: number;
  top: number;
  width: number;
  height: number;
  color: Rgb;
}

export interface LinkBox {
  target: string; // an anchorKey into the book, or an external URL
  external: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface HeadingMark {
  level: number; // 1–6
  title: string;
  top: number;
}

export interface LaidOutChapter {
  path: string;
  texts: TextRun[];
  images: ImageBox[];
  boxes: FilledBox[];
  links: LinkBox[];
  anchors: Map<string, number>; // element id → its top
  breaks: number[]; // where the book asks for a page break
  headings: HeadingMark[]; // for an outline, when the book has no table of contents
  // A page that's only a picture (a cover, a full-page plate): drawn as large
  // as the page allows.
  fullPageImage?: ImageBox;
}
