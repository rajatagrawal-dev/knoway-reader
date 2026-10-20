import serifBoldItalicUrl from "@expo-google-fonts/literata/700Bold_Italic/Literata_700Bold_Italic.ttf?url";
import serifBoldUrl from "@expo-google-fonts/literata/700Bold/Literata_700Bold.ttf?url";
import serifItalicUrl from "@expo-google-fonts/literata/400Regular_Italic/Literata_400Regular_Italic.ttf?url";
import serifUrl from "@expo-google-fonts/literata/400Regular/Literata_400Regular.ttf?url";
import monoBoldUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono-Bold.ttf?url";
import monoUrl from "dejavu-fonts-ttf/ttf/DejaVuSansMono.ttf?url";
import fallbackUrl from "dejavu-fonts-ttf/ttf/DejaVuSans.ttf?url";
import { readEpub } from "./book.ts";
import { createLayout } from "./layout.ts";
import { findEntry, sniffImageType } from "./paths.ts";
import type { FontName, ImageSource, LaidOutChapter } from "./types.ts";
import { BOOK_PAGE, columnSize, writePdf, type LoadedImage } from "./writePdf.ts";

// EPUB support: an EPUB is turned into a PDF when it's added to the library
// (index.ts), and from then on the reader works with that PDF like any other
// — every feature (highlights, notes, Deep Dive, Ask, the glossary,
// cross-references, search, the table of contents, export) applies
// unchanged. The book is laid out once, as a 6×9in paperback set in Literata.

const FONT_URLS: Record<FontName, string> = {
  serif: serifUrl,
  "serif-bold": serifBoldUrl,
  "serif-italic": serifItalicUrl,
  "serif-bold-italic": serifBoldItalicUrl,
  mono: monoUrl,
  "mono-bold": monoBoldUrl,
  fallback: fallbackUrl,
};

let fontsPromise: Promise<Record<FontName, Uint8Array>> | null = null;

function loadFonts(): Promise<Record<FontName, Uint8Array>> {
  fontsPromise ??= Promise.all(
    Object.entries(FONT_URLS).map(async ([name, url]) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Couldn't load the ${name} font.`);
      return [name, new Uint8Array(await response.arrayBuffer())] as const;
    }),
  )
    .then((entries) => Object.fromEntries(entries) as Record<FontName, Uint8Array>)
    .catch((error) => {
      fontsPromise = null; // try again next time
      throw error;
    });
  return fontsPromise;
}

// Draws a picture the PDF can't take as it is (GIF, WebP, SVG, …) onto a
// canvas and returns it as a PNG. Vector pictures are drawn at three pixels
// per point, so they stay crisp when zoomed in.
async function rasterize(blob: Blob, width: number, height: number, vector: boolean): Promise<LoadedImage | null> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const density = vector ? 3 : 1;
    const maxSide = 3000;
    let w = vector ? width * density : img.naturalWidth;
    let h = vector ? height * density : img.naturalHeight;
    if (!(w > 0 && h > 0)) return null;
    const shrink = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(1, Math.round(w * shrink));
    h = Math.max(1, Math.round(h * shrink));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(img, 0, 0, w, h);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return png ? { bytes: new Uint8Array(await png.arrayBuffer()), type: "png" } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface ConvertedEpub {
  pdf: Uint8Array;
  title?: string;
  authors: string[];
}

export async function convertEpubToPdf(bytes: Uint8Array): Promise<ConvertedEpub> {
  const book = readEpub(bytes);
  const fonts = await loadFonts();
  const column = columnSize(BOOK_PAGE);
  const session = await createLayout(book, fonts, column);
  const chapters: LaidOutChapter[] = [];
  try {
    for (const path of book.spine) chapters.push(await session.layoutChapter(path));
  } finally {
    session.dispose();
  }

  // A cover the book names but doesn't open with gets a page of its own.
  if (book.coverImage) {
    const opening = chapters.find((chapter) => chapter.texts.length > 0 || chapter.images.length > 0);
    const shown = opening?.images.some((image) => "path" in image.source && image.source.path === book.coverImage);
    if (!shown) {
      const cover = { source: { path: book.coverImage }, left: 0, top: 0, width: column.width, height: column.height };
      chapters.unshift({
        path: "#cover",
        texts: [],
        images: [cover],
        boxes: [],
        links: [],
        anchors: new Map(),
        breaks: [],
        headings: [],
        fullPageImage: cover,
      });
    }
  }

  const loadImage = async (
    source: ImageSource,
    width: number,
    height: number,
    redraw: boolean,
  ): Promise<LoadedImage | null> => {
    if ("svg" in source) return rasterize(new Blob([source.svg], { type: "image/svg+xml" }), width, height, true);
    const entry = findEntry(book.files, source.path);
    const data = entry ? book.files.get(entry) : undefined;
    if (!data) return null;
    const type = sniffImageType(data);
    if ((type === "jpeg" || type === "png") && !redraw) return { bytes: data, type };
    const mime = type === "svg" ? "image/svg+xml" : type === "other" ? "" : `image/${type}`;
    return rasterize(new Blob([data as BlobPart], { type: mime }), width, height, type === "svg");
  };

  const pdf = await writePdf({
    title: book.title,
    authors: book.authors,
    language: book.language,
    toc: book.toc,
    chapters,
    fonts,
    loadImage,
  });
  return { pdf, title: book.title, authors: book.authors };
}
