interface DiveBadgeProps {
  onClick: () => void;
}

export default function DiveBadge({ onClick }: DiveBadgeProps) {
  return (
    <button
      type="button"
      className="dive-badge"
      title="Open this dive"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      Dive ↗
    </button>
  );
}
