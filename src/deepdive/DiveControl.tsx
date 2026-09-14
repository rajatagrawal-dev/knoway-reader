interface DiveControlProps {
  // Present once this highlight/selection already has an associated dive;
  // clicking opens it instead of starting a second one.
  divePanelId?: string;
  // Only reachable when divePanelId is set, so a fresh-selection caller
  // (which never has one) can leave this out.
  onOpen?: (divePanelId: string) => void;
  onStart: () => void;
}

export default function DiveControl({ divePanelId, onOpen, onStart }: DiveControlProps) {
  return (
    <button
      type="button"
      className="dive-badge"
      title={divePanelId ? "Open this dive" : "Dive deeper"}
      onClick={(event) => {
        event.stopPropagation();
        if (divePanelId) {
          onOpen?.(divePanelId);
        } else {
          onStart();
        }
      }}
    >
      Dive ↗
    </button>
  );
}
