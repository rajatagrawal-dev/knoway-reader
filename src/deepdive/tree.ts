import type { RegionRect } from "../grounding/attachments.ts";
import type { SourceRef } from "../grounding/types.ts";
import type { ChainEntry, DiveImage, DivePanel, DiveTurn } from "./types.ts";

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
  pageNumber?: number;
  region?: RegionRect;
}): DivePanel {
  return {
    id: getNextId(),
    parentId: null,
    anchorHighlightId: params.anchorHighlightId,
    selection: params.selection,
    selectionImage: params.selectionImage,
    label: params.selection ? params.selection.slice(0, 60) : "Selected region",
    contextText: params.contextText,
    pageNumber: params.pageNumber,
    ...(params.region ? { region: params.region } : {}),
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function createNestedPanel(params: {
  parentId: string;
  selection: string;
  contextText: string;
  inheritedSources?: SourceRef[];
}): DivePanel {
  return {
    id: getNextId(),
    parentId: params.parentId,
    anchorHighlightId: null,
    selection: params.selection,
    label: params.selection.slice(0, 60),
    contextText: params.contextText,
    inheritedSources: params.inheritedSources,
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function appendTurn(
  panel: DivePanel,
  role: DiveTurn["role"],
  content: string,
  extra: Pick<DiveTurn, "sources" | "attachments" | "suggestions" | "diagram"> = {},
): DivePanel {
  const { sources, attachments, suggestions, diagram } = extra;
  return {
    ...panel,
    turns: [
      ...panel.turns,
      {
        role,
        content,
        at: new Date().toISOString(),
        ...(sources ? { sources } : {}),
        ...(attachments?.length ? { attachments } : {}),
        ...(suggestions?.length ? { suggestions } : {}),
        ...(diagram ? { diagram } : {}),
      },
    ],
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

// Walks parentId pointers up from panelId to the panel with no parent — the
// root dive anchored directly to a PDF highlight. Every dive, however deeply
// nested, traces back to exactly one of these; its anchorHighlightId is the
// "starting point" in the main text for the whole branch.
export function rootPanelOf(panels: DivePanel[], panelId: string): DivePanel | null {
  let current = panelById(panels, panelId);
  while (current && current.parentId) {
    current = panelById(panels, current.parentId);
  }
  return current;
}

// panelId plus every panel nested underneath it (transitively, via
// parentId) — the set that must be deleted together when the highlight
// anchoring panelId is deleted, so a removed annotation takes its whole
// dive subtree (and everything dived into further down that branch) with
// it rather than leaving orphaned panels behind.
export function panelSubtreeIds(panels: DivePanel[], panelId: string): Set<string> {
  const ids = new Set<string>([panelId]);
  let added = true;
  while (added) {
    added = false;
    for (const panel of panels) {
      if (panel.parentId && ids.has(panel.parentId) && !ids.has(panel.id)) {
        ids.add(panel.id);
        added = true;
      }
    }
  }
  return ids;
}

// Every panel in the tree rooted at rootId, depth-first in creation order,
// with its depth (the root is 0) — what the dive map and tree summary walk.
export function treeOf(panels: DivePanel[], rootId: string): { panel: DivePanel; depth: number }[] {
  const out: { panel: DivePanel; depth: number }[] = [];
  const visit = (id: string, depth: number) => {
    const panel = panelById(panels, id);
    if (!panel) return;
    out.push({ panel, depth });
    childrenOf(panels, id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .forEach((child) => visit(child.id, depth + 1));
  };
  visit(rootId, 0);
  return out;
}

// The turns a request resends (the backend is stateless): the last two
// exchanges — and with keepOpeningAnswer, the dive's first exchange too,
// which later questions usually refer back to.
export function historyTurns(turns: DiveTurn[], historyTurns: number, keepOpening: boolean): DiveTurn[] {
  const first = Math.max(0, turns.length - 1 - historyTurns);
  const recent = turns.slice(first);
  return keepOpening && first >= 2 ? [turns[0], turns[1], ...recent] : recent;
}
