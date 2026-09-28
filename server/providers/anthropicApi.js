import { forEachSSEData } from "./sse.js";
import { withTimeoutSignal, REQUEST_TIMEOUT_MS } from "./timeout.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 8192;

function toAnthropicMessages(messages) {
  return messages.map((m) => ({
    role: m.role,
    content: m.image
      ? [
          { type: "text", text: m.content },
          {
            type: "image",
            source: { type: "base64", media_type: m.image.mediaType, data: m.image.data },
          },
        ]
      : m.content,
  }));
}

async function post(fetchImpl, apiKey, body, signal, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw err?.name === "AbortError"
      ? new Error(`Anthropic API request timed out after ${timeoutMs}ms`)
      : err;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Anthropic API error ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res;
}

// The real Anthropic Messages API, via ANTHROPIC_API_KEY — as opposed to
// ./anthropicCli.js, which shells out to the `claude` CLI and rides
// subscription auth instead.
export function createAnthropicApiProvider({ apiKey, model, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS }) {
  return {
    async streamReply({ system, messages, onText }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const res = await post(
          fetchImpl,
          apiKey,
          { model, system, max_tokens: MAX_TOKENS, stream: true, messages: toAnthropicMessages(messages) },
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
            if (
              evt.type === "content_block_delta" &&
              evt.delta?.type === "text_delta" &&
              typeof evt.delta.text === "string"
            ) {
              accumulated += evt.delta.text;
              if (onText) onText(evt.delta.text);
            } else if (evt.type === "error") {
              throw new Error(evt.error?.message || "Anthropic API returned an error.");
            }
          });
        } catch (err) {
          throw err?.name === "AbortError"
            ? new Error(`Anthropic API request timed out after ${timeoutMs}ms`)
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
        const res = await post(
          fetchImpl,
          apiKey,
          { model, system, max_tokens: MAX_TOKENS, messages: [{ role: "user", content: prompt }] },
          signal,
          timeoutMs,
        );
        const data = await res.json();
        const block = (data.content || []).find((b) => b.type === "text");
        return block?.text || "";
      } finally {
        clear();
      }
    },
  };
}
