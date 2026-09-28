export interface DiveMessage {
  role: "user" | "assistant";
  content: string;
  image?: { mediaType: string; data: string };
}

// In the browser (and Tauri's dev webview, which loads the Vite dev
// server) relative "/api/..." requests work as-is via Vite's proxy. A
// packaged Tauri build loads the frontend from its own asset scheme
// (tauri://localhost, or http://tauri.localhost on Windows) instead, so
// "/api/..." has to be pointed at the bundled server (see src-tauri/src/lib.rs)
// explicitly.
const API_BASE =
  typeof window !== "undefined" &&
  (window.location.protocol === "tauri:" || window.location.hostname === "tauri.localhost")
    ? "http://localhost:4300"
    : "";

// Reads one of the backend's SSE streams (see server/app.js's streamSse),
// forwarding each text delta to onText and resolving with the final full
// reply text once the "done" frame arrives.
async function postSse(
  path: string,
  body: unknown,
  onText: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
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
        onText(data.text);
      }
    }
  }

  return full;
}

export function streamDiveReply(params: {
  system: string;
  messages: DiveMessage[];
  onText: (chunk: string) => void;
}): Promise<string> {
  return postSse("/api/dive/stream", { system: params.system, messages: params.messages }, params.onText);
}

export function streamGlossaryDefinition(params: {
  system: string;
  prompt: string;
  onText: (chunk: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  return postSse("/api/glossary/stream", { system: params.system, prompt: params.prompt }, params.onText, params.signal);
}

export async function quickMeaning(params: { system: string; prompt: string }): Promise<string> {
  const res = await fetch(`${API_BASE}/api/dive/quick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.answer;
}
