import { messageImages } from "./images.js";
import { forEachSSEData } from "./sse.js";
import { withTimeoutSignal, REQUEST_TIMEOUT_MS } from "./timeout.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function toGeminiContents(messages) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      { text: m.content },
      ...messageImages(m).map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data } })),
    ],
  }));
}

// Token counts as every provider reports them to onUsage. Gemini's thinking
// tokens are billed as output.
function toUsage(meta) {
  return {
    inputTokens: meta.promptTokenCount ?? 0,
    cachedInputTokens: meta.cachedContentTokenCount ?? 0,
    outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
  };
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
// Gemini's thinking models count their thinking against maxOutputTokens, so
// the role's answer cap gets the same headroom as other reasoning models
// (see ./openAiCompatible.js).
const THINKING_ALLOWANCE = 8192;

export function createGoogleProvider({ apiKey, model, maxTokens, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const generationConfig = maxTokens ? { generationConfig: { maxOutputTokens: maxTokens + THINKING_ALLOWANCE } } : {};
  return {
    async streamReply({ system, messages, onText, onUsage }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const url = `${API_BASE}/${model}:streamGenerateContent?alt=sse`;
        const res = await post(
          fetchImpl,
          apiKey,
          url,
          { systemInstruction: { parts: [{ text: system }] }, contents: toGeminiContents(messages), ...generationConfig },
          signal,
          timeoutMs,
        );

        let accumulated = "";
        // Each chunk carries running totals; the last one is final.
        let usage = null;
        try {
          await forEachSSEData(res, (data) => {
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              return;
            }
            if (evt.usageMetadata) usage = evt.usageMetadata;
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
        if (usage && onUsage) onUsage(toUsage(usage));
        return accumulated;
      } finally {
        clear();
      }
    },

    async complete({ system, prompt, onUsage }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const url = `${API_BASE}/${model}:generateContent`;
        const res = await post(
          fetchImpl,
          apiKey,
          url,
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            ...generationConfig,
          },
          signal,
          timeoutMs,
        );
        const data = await res.json();
        if (data.usageMetadata && onUsage) onUsage(toUsage(data.usageMetadata));
        const parts = data.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || "").join("");
      } finally {
        clear();
      }
    },
  };
}
