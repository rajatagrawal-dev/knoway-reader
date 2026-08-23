import type { DiveImage } from "./types";

// Area-highlight screenshots come from the library as "data:image/png;base64,..."
// data URLs; the CLI's stream-json image content block wants the media type
// and base64 payload split apart.
export function parseDataUrlImage(dataUrl: string | undefined): DiveImage | undefined {
  if (!dataUrl) return undefined;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return undefined;
  return { mediaType: match[1], data: match[2] };
}
