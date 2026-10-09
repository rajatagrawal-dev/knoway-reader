import { messageImages } from "./images.js";
import { forEachSSEData } from "./sse.js";
import { withTimeoutSignal, REQUEST_TIMEOUT_MS } from "./timeout.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Used only when a role doesn't set its own cap (see ../models.js).
const DEFAULT_MAX_TOKENS = 8192;

// A system prompt this long (roughly 1,000+ tokens — Anthropic's minimum
// cacheable prefix) is marked for prompt caching: Ask and dive follow-ups
// resend the same sources block, and a cache hit bills it at a fraction.
const CACHE_MIN_SYSTEM_CHARS = 4000;

// With a suffix (a dive follow-up's own sources, see src/deepdive/prompts.ts)
// the system prompt goes as two blocks, and only the first — identical
// across the dive's follow-ups — is marked for caching.
function systemBlock(system, suffix) {
  if (suffix) {
    const first = { type: "text", text: system };
    if (system.length >= CACHE_MIN_SYSTEM_CHARS) first.cache_control = { type: "ephemeral" };
    return [first, { type: "text", text: suffix }];
  }
  return system.length >= CACHE_MIN_SYSTEM_CHARS
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : system;
}

// Token counts as every provider reports them to onUsage.
function toUsage(usage) {
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}

function toAnthropicMessages(messages) {
  return messages.map((m) => {
    const images = messageImages(m);
    return {
      role: m.role,
      content: images.length
        ? [
            { type: "text", text: m.content },
            ...images.map((image) => ({
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.data },
            })),
          ]
        : m.content,
    };
  });
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

// The Anthropic Messages API, via ANTHROPIC_API_KEY.
export function createAnthropicApiProvider({
  apiKey,
  model,
  maxTokens = DEFAULT_MAX_TOKENS,
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  return {
    // Takes a separate systemSuffix (see systemBlock); providers without
    // this get it appended to the system prompt (../models.js).
    supportsSystemSuffix: true,

    async streamReply({ system, systemSuffix, messages, onText, onUsage }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const res = await post(
          fetchImpl,
          apiKey,
          { model, system: systemBlock(system, systemSuffix), max_tokens: maxTokens, stream: true, messages: toAnthropicMessages(messages) },
          signal,
          timeoutMs,
        );

        let accumulated = "";
        // Input counts arrive in message_start, the final output count in
        // message_delta.
        let usage = null;
        try {
          await forEachSSEData(res, (data) => {
            let evt;
            try {
              evt = JSON.parse(data);
            } catch {
              return;
            }
            if (evt.type === "message_start" && evt.message?.usage) {
              usage = { ...evt.message.usage };
            } else if (evt.type === "message_delta" && evt.usage) {
              usage = { ...usage, ...evt.usage };
            } else if (
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
        if (usage && onUsage) onUsage(toUsage(usage));
        return accumulated;
      } finally {
        clear();
      }
    },

    async complete({ system, prompt, onUsage }) {
      const { signal, clear } = withTimeoutSignal(timeoutMs);
      try {
        const res = await post(
          fetchImpl,
          apiKey,
          { model, system: systemBlock(system), max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
          signal,
          timeoutMs,
        );
        const data = await res.json();
        if (data.usage && onUsage) onUsage(toUsage(data.usage));
        const block = (data.content || []).find((b) => b.type === "text");
        return block?.text || "";
      } finally {
        clear();
      }
    },
  };
}
