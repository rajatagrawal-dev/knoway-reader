import { useState, type FormEvent } from "react";

interface CommentFormProps {
  onSubmit: (input: string) => void;
  placeholder?: string;
}

export default function CommentForm({
  onSubmit,
  placeholder = "Add a comment…",
}: CommentFormProps) {
  const [input, setInput] = useState("");

  return (
    <form
      className="comment-form"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit(input);
        setInput("");
      }}
    >
      <textarea
        value={input}
        placeholder={placeholder}
        rows={3}
        onChange={(event) => setInput(event.target.value)}
      />
      <button type="submit">Save highlight</button>
    </form>
  );
}
