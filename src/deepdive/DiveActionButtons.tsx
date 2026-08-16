import { useState } from "react";

export interface DiveActionButtonsProps {
  onDiveDeeper: () => void;
  onQuickMeaning: () => Promise<string>;
  onPin: () => void;
}

export default function DiveActionButtons({
  onDiveDeeper,
  onQuickMeaning,
  onPin,
}: DiveActionButtonsProps) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinned, setPinned] = useState(false);

  const handleQuickMeaning = async () => {
    setLoading(true);
    setAnswer(null);
    try {
      setAnswer(await onQuickMeaning());
    } catch (err) {
      setAnswer(err instanceof Error ? err.message : "Failed to get an answer.");
    } finally {
      setLoading(false);
    }
  };

  const handlePin = () => {
    onPin();
    setPinned(true);
  };

  return (
    <div className="dive-action-buttons">
      <div className="dive-action-row">
        <button type="button" onClick={onDiveDeeper}>
          Dive deeper
        </button>
        <button type="button" onClick={handleQuickMeaning} disabled={loading}>
          {loading ? "Thinking…" : "Quick meaning"}
        </button>
        <button type="button" onClick={handlePin} disabled={pinned}>
          {pinned ? "Pinned" : "Pin"}
        </button>
      </div>
      {answer ? <p className="dive-action-answer">{answer}</p> : null}
    </div>
  );
}
