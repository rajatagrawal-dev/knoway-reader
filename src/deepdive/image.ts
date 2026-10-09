import type { DiveImage } from "./types";

// Area-highlight screenshots come from the library as "data:image/png;base64,..."
// data URLs; provider image content blocks want the media type and base64
// payload split apart.
export function parseDataUrlImage(dataUrl: string | undefined): DiveImage | undefined {
  if (!dataUrl) return undefined;
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return undefined;
  return { mediaType: match[1], data: match[2] };
}

// Images are billed by size, and a screenshot of a page region rarely needs
// more than ~1000px on its long side for the model to read it. Anything
// larger is scaled down (as JPEG — far smaller than PNG for page renders)
// before it's stored with the dive and sent on each turn.
const MAX_IMAGE_SIDE = 1000;

export async function downscaleImage(image: DiveImage, maxSide = MAX_IMAGE_SIDE): Promise<DiveImage> {
  try {
    const element = new Image();
    element.src = `data:${image.mediaType};base64,${image.data}`;
    await element.decode();
    const scale = maxSide / Math.max(element.naturalWidth, element.naturalHeight);
    if (!(scale < 1)) return image;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(element.naturalWidth * scale);
    canvas.height = Math.round(element.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return image;
    context.fillStyle = "#fff"; // JPEG has no transparency
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    return parseDataUrlImage(canvas.toDataURL("image/jpeg", 0.85)) ?? image;
  } catch {
    return image; // undecodable: send it as it is
  }
}
