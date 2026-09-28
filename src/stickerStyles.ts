import type { CSSProperties } from "react";

// Sticky-note ("sticker") look: soft paper tones, each paired with a deeper
// shade of the same hue for the note's edge stripe and folded corner (see
// .FreetextHighlight__container in App.css, which reads these as CSS vars).
interface StickerPaper {
  name: string;
  paper: string;
  accent: string;
}

export const STICKER_PAPERS: Record<string, StickerPaper> = {
  "#fff3c4": { name: "Butter", paper: "#fff3c4", accent: "#e8b923" },
  "#fde2dc": { name: "Blush", paper: "#fde2dc", accent: "#e07a67" },
  "#e2f0dc": { name: "Sage", paper: "#e2f0dc", accent: "#6fa35e" },
  "#dde9f7": { name: "Mist", paper: "#dde9f7", accent: "#5b8fd1" },
  "#ebe3f7": { name: "Lavender", paper: "#ebe3f7", accent: "#9577cc" },
  "#fbfaf7": { name: "Paper", paper: "#fbfaf7", accent: "#b7b3ab" },
  transparent: { name: "None", paper: "transparent", accent: "transparent" },
};

export const STICKER_DEFAULT_PAPER = "#fff3c4";
export const STICKER_PAPER_PRESETS = Object.keys(STICKER_PAPERS);
export const STICKER_PAPER_NAMES = Object.fromEntries(
  Object.entries(STICKER_PAPERS).map(([key, { name }]) => [key, name]),
);

// Notes saved with the library's original presets map onto their nearest
// counterpart in the new palette.
const LEGACY_PAPERS: Record<string, string> = {
  "#ffffc8": "#fff3c4",
  "#ffcdd2": "#fde2dc",
  "#c8e6c9": "#e2f0dc",
  "#bbdefb": "#dde9f7",
  "#e1bee7": "#ebe3f7",
};

export function resolveStickerPaper(backgroundColor?: string): string {
  if (!backgroundColor) return STICKER_DEFAULT_PAPER;
  return LEGACY_PAPERS[backgroundColor.toLowerCase()] ?? backgroundColor;
}

export const STICKER_INK_DEFAULT = "#2b2a27";
export const STICKER_INK_NAMES: Record<string, string> = {
  "#2b2a27": "Ink",
  "#b3261e": "Crimson",
  "#1f4e8c": "Navy",
  "#2e6b3a": "Forest",
  "#6b3fa0": "Plum",
};
export const STICKER_INK_PRESETS = Object.keys(STICKER_INK_NAMES);

// Local/system fonts only — the desktop build can't count on web fonts.
export const STICKER_FONTS = [
  { value: "inherit", label: "Sans" },
  { value: 'Charter, "Iowan Old Style", Georgia, serif', label: "Serif" },
  { value: '"Noteworthy", "Bradley Hand", "Segoe Print", cursive', label: "Handwritten" },
  { value: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', label: "Mono" },
];

// CSS vars the sticker's stylesheet reads. A custom (non-preset) paper
// color derives its accent with color-mix.
export function stickerStyle(paper: string): CSSProperties {
  const accent = STICKER_PAPERS[paper]?.accent ?? `color-mix(in srgb, ${paper} 60%, #000)`;
  return {
    "--sticker-paper": paper,
    "--sticker-accent": accent,
  } as CSSProperties;
}
