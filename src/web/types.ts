// "Add from URL": the shapes passed between the stages of turning a web
// address into a document in the library (see index.ts for the stages).

export type FetchPurpose = "page" | "asset";

export interface FetchedResource {
  url: string; // as requested
  finalUrl: string; // after redirects
  contentType: string;
  bytes: Uint8Array;
}

// Gets bytes off the web. The app's implementation goes through its own
// server (fetcher.ts), since other sites don't let the page fetch them
// directly; a headless browser could stand in for it.
export interface WebFetcher {
  fetch(url: string, options: { purpose: FetchPurpose; referer?: string; signal?: AbortSignal }): Promise<FetchedResource>;
  // A URL a frame in the app can load the resource from directly (the
  // styled render's pictures, fonts and stylesheets: renderer.ts).
  assetUrl(url: string, referer: string): string;
}

// What the page says about itself: from its metadata, its structured data
// and what it shows around its title (metadata.ts).
export interface PageMetadata {
  title: string;
  authors: string[];
  siteName?: string;
  description?: string;
  dek?: string; // the subtitle shown under the title, when the page shows one
  publishedAt?: string; // ISO date (or date-time) when it could be read
  publishedLabel?: string; // as the page prints it, when it isn't machine-readable
  modifiedAt?: string;
  lang?: string;
  canonicalUrl?: string;
  pdfUrl?: string; // a PDF of the same work (citation_pdf_url), as scholarly pages offer
  // data-kr-id of the title heading on the page, and of the block around
  // it (where a byline, date or lead picture would be).
  titleId?: string;
  headerId?: string;
}

// What happened to everything on the page that couldn't simply be kept as
// text and pictures. Shown to the reader after the import, so nothing goes
// missing silently.
export interface ImportReport {
  imagesSaved: number;
  imagesFailed: { url: string; alt: string }[];
  figuresCaptured: number; // drawn with CSS on the page, captured as pictures
  figuresFailed: number; // …that couldn't be captured, kept as their text
  media: { kind: "video" | "audio" | "embed" | "code"; url: string; title?: string }[]; // saved as links
  mathAsTex: number; // formulas shown as their TeX source
  restoredBlocks: number; // passages the article extractor dropped and that were put back
  warnings: string[];
}

export function emptyReport(): ImportReport {
  return { imagesSaved: 0, imagesFailed: [], figuresCaptured: 0, figuresFailed: 0, media: [], mathAsTex: 0, restoredBlocks: 0, warnings: [] };
}

export type ImportStage =
  | "checking" // already in the library?
  | "fetching"
  | "reading" // finding the article
  | "images"
  | "figures"
  | "layout"
  | "saving";

export interface ImportProgress {
  stage: ImportStage;
  done?: number;
  total?: number;
}

// A failure worth showing the reader as it is.
export class WebImportError extends Error {}
