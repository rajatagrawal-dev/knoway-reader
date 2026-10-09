import { Network } from "lucide-react";
import { usePopover } from "../components/usePopover";
import { treeOf } from "./tree";
import type { DivePanel } from "./types";

// The whole dive tree at a glance (the diveMap experiment): every dive
// started from one passage, indented by depth, the open one marked. The
// breadcrumb only shows the path to where you are; this shows where else
// you've been.
export default function DiveMap({
  panels,
  rootId,
  focusId,
  onFocus,
  pageLabel,
}: {
  panels: DivePanel[];
  rootId: string;
  focusId: string;
  onFocus: (id: string) => void;
  pageLabel: (pageNumber: number) => string;
}) {
  const popover = usePopover();
  const tree = treeOf(panels, rootId);

  return (
    <div className="deep-dive-tool" ref={popover.ref}>
      <button
        type="button"
        className={`deep-dive-tool-button${popover.open ? " active" : ""}`}
        onClick={() => popover.setOpen((open) => !open)}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        title="Every dive from this passage"
      >
        <Network width={14} height={14} aria-hidden="true" />
        Map{tree.length > 1 ? ` · ${tree.length}` : ""}
      </button>
      {popover.open ? (
        <div className="dive-map" role="dialog" aria-label="Dive map">
          <ul>
            {tree.map(({ panel, depth }) => {
              const answers = panel.turns.filter((turn) => turn.role === "assistant").length;
              return (
                <li key={panel.id} style={{ paddingLeft: `${depth * 14}px` }}>
                  <button
                    type="button"
                    className={`dive-map-item${panel.id === focusId ? " current" : ""}`}
                    onClick={() => {
                      onFocus(panel.id);
                      popover.setOpen(false);
                    }}
                  >
                    <span className="dive-map-label">{panel.label || "Selected region"}</span>
                    <span className="dive-map-meta">
                      {depth === 0 && panel.pageNumber !== undefined ? `p. ${pageLabel(panel.pageNumber)} · ` : ""}
                      {answers} answer{answers === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
