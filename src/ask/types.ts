import type { AskBasis, AskScope } from "../grounding/ask";
import type { Attachment } from "../grounding/attachments";
import type { SourceRef } from "../grounding/types";

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO timestamp
  // Assistant turns: the passages the answer was given (its [S1]-style
  // markers refer to these), and what they were — for "Based on…".
  sources?: SourceRef[];
  basis?: AskBasis;
  scope?: AskScope; // the scope it was asked in
  wider?: boolean; // answered after "Search wider"
  generalAllowed?: boolean; // answered after "Answer from general knowledge"
  status?: "streaming" | "error";
  // User turns: what the reader added to the question ("Add to question").
  attachments?: Attachment[];
}

// One line of questioning about a document. Kept per document in its own
// store (the "threads" kind), apart from the reader's annotations.
export interface AskThread {
  id: string;
  title: string; // the first question, until renamed
  // Unused: each question's scope is now read from the question itself
  // (grounding/scope.ts) and kept on its answer. Threads saved before still
  // carry it.
  scope?: AskScope;
  turns: AskTurn[];
  createdAt: string;
  updatedAt: string;
}
