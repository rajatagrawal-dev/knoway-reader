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
}
