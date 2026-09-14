// Mirrors react-pdf-highlighter-plus's own (unexported) TextHighlight color
// presets/names so every highlight color menu in the app (the main PDF
// selection tip, the dive-panel selection tip) offers the exact same
// choices as the one shown when editing an existing PDF highlight.
export const HIGHLIGHT_COLOR_PRESETS = [
  "rgba(255, 226, 143, 1)",
  "#ffcdd2",
  "#c8e6c9",
  "#bbdefb",
  "#e1bee7",
];

export const HIGHLIGHT_COLOR_NAMES: Record<string, string> = {
  "rgba(255, 226, 143, 1)": "Yellow",
  "#ffcdd2": "Red",
  "#c8e6c9": "Green",
  "#bbdefb": "Blue",
  "#e1bee7": "Purple",
};
