export interface DiveMessage {
  role: "user" | "assistant";
  content: string;
}

// Reads the backend's SSE stream (see server/app.js's /api/dive/stream),
// forwarding each text delta to onText and resolving with the final full
// reply text once the "done" frame arrives.
export async function streamDiveReply(params: {
  system: string;
  messages: DiveMessage[];
  onText: (chunk: string) => void;
}): Promise<string> {
  const res = await fetch("/api/dive/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: params.system, messages: params.messages }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(data.error);
      if (data.done) {
        full = data.text ?? full;
      } else if (typeof data.text === "string") {
        full += data.text;
        params.onText(data.text);
      }
    }
  }

  return full;
}

export async function quickMeaning(params: { system: string; prompt: string }): Promise<string> {
  const res = await fetch("/api/dive/quick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.answer;
}
