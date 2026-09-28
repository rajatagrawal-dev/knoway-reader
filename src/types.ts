import type { Content, Highlight } from "react-pdf-highlighter-plus";

export interface CommentedHighlight extends Highlight {
  content: Content;
  comment?: string;
  highlightColor?: string;
  highlightStyle?: "highlight" | "underline" | "strikethrough";
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontFamily?: string;
  divePanelId?: string;
  // Unset on highlights saved before this was recorded.
  createdAt?: string;
  // A short-lived, never-saved highlight marking where a glossary reference
  // jumped to (see App.tsx's jumpToGlossaryRef).
  glossaryFlash?: boolean;
}
