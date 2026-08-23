import type { ChainEntry, DiveImage, DivePanel, DiveTurn } from "./types";

export function panelById(panels: DivePanel[], id: string): DivePanel | null {
  return panels.find((p) => p.id === id) ?? null;
}

// Walks parentId pointers from focusId up to the implicit PDF root, producing
// an ordered [root, ..., focused] list — the same shape both the breadcrumb
// and the pane window are derived from.
export function ancestorChain(
  panels: DivePanel[],
  focusId: string | null,
  rootLabel: string,
): ChainEntry[] {
  const chain: ChainEntry[] = [];
  let id = focusId;
  while (id != null) {
    const panel = panelById(panels, id);
    if (!panel) break;
    chain.unshift({ id: panel.id, label: panel.label });
    id = panel.parentId;
  }
  chain.unshift({ id: null, label: rootLabel });
  return chain;
}

// The split view always shows at most the last two entries of the chain.
export function paneWindow(chain: ChainEntry[]): ChainEntry[] {
  return chain.slice(-2);
}

const getNextId = () => crypto.randomUUID();

export function createRootPanel(params: {
  anchorHighlightId: string;
  selection: string;
  contextText: string;
  selectionImage?: DiveImage;
}): DivePanel {
  return {
    id: getNextId(),
    parentId: null,
    anchorHighlightId: params.anchorHighlightId,
    selection: params.selection,
    selectionImage: params.selectionImage,
    label: params.selection ? params.selection.slice(0, 60) : "Selected region",
    contextText: params.contextText,
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function createNestedPanel(params: {
  parentId: string;
  selection: string;
  contextText: string;
}): DivePanel {
  return {
    id: getNextId(),
    parentId: params.parentId,
    anchorHighlightId: null,
    selection: params.selection,
    label: params.selection.slice(0, 60),
    contextText: params.contextText,
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function appendTurn(panel: DivePanel, role: DiveTurn["role"], content: string): DivePanel {
  return {
    ...panel,
    turns: [...panel.turns, { role, content, at: new Date().toISOString() }],
  };
}

export function replacePanel(panels: DivePanel[], updated: DivePanel): DivePanel[] {
  return panels.map((p) => (p.id === updated.id ? updated : p));
}

// Direct children of a panel — used to find which of a panel's own dive
// branches to render as inline clickable markers in its turn text (Task 12).
export function childrenOf(panels: DivePanel[], parentId: string): DivePanel[] {
  return panels.filter((p) => p.parentId === parentId);
}
