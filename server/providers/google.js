import { forEachSSEData } from "./sse.js";
import { withTimeoutSignal, REQUEST_TIMEOUT_MS } from "./timeout.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: m.image
      ? [{ text: m.content }, { inlineData: { mimeType: m.image.mediaType, data: m.image.data } }]
      : [{ text: m.content }],
  }));
}

async function post(fetchImpl, apiKey, url, body, signal, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw err?.name === "AbortError"
      ? new Error(`Gemini API request timed out after ${timeoutMs}ms`)
      : err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

// Google's Gemini API, via GOOGLE_API_KEY.
export function createGoogleProvider({ apiKey, model, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return {
    async streamReply({ system, messages, onText }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse`;
        const res = await post(
          fetchImpl,
          apiKey,
          url,
          { systemInstruction: { parts: [{ text: system }] }, contents: toGeminiContents(messages) },
          signal,
          timeoutMs,
        );

        let accumulated = "";
        try {
          await forEachSSEData(res, (data) => {
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              return;
            }
            const parts = evt.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (typeof part.text === "string") {
                accumulated += part.text;
                if (onText) onText(part.text);
              }
            }
          });
        } catch (err) {
          throw err?.name === "AbortError"
            ? new Error(`Gemini API request timed out after ${timeoutMs}ms`)
            : err;
        }
        return accumulated;
      } finally {
        clear();
      }
    },

    async complete({ system, prompt }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const url = `${API_BASE}/${model}:generateContent`;
        const res = await post(
          fetchImpl,
          apiKey,
          url,
          { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }] },
          signal,
          timeoutMs,
        );
        const data = await res.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || "").join("");
      } finally {
        clear();
      }
    },
  };
}
