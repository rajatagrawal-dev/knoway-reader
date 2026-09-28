import type { ReactNode } from "react";
import { Highlighter, Strikethrough, Underline } from "lucide-react";

export type HighlightStyle = "highlight" | "underline" | "strikethrough";

// The style choices offered wherever a text highlight's look is picked:
// the highlight tooltip (HighlightToolbar) and Highlight mode's pen menu
// (AppRail).
export const STYLE_BUTTONS: { style: HighlightStyle; title: string; icon: ReactNode }[] = [
  { style: "highlight", title: "Highlight", icon: <Highlighter width={16} height={16} /> },
  { style: "underline", title: "Underline", icon: <Underline width={16} height={16} /> },
  { style: "strikethrough", title: "Strikethrough", icon: <Strikethrough width={16} height={16} /> },
];
