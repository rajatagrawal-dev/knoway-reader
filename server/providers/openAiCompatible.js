import OpenAI from "openai";
import { REQUEST_TIMEOUT_MS } from "./timeout.js";

function toChatMessages(system, messages) {
  const turns = messages.map((m) => ({
    role: m.role,
    content: m.image
      ? [
          { type: "text", text: m.content },
          { type: "image_url", image_url: { url: `data:${m.image.mediaType};base64,${m.image.data}` } },
        ]
      : m.content,
  }));
  return [{ role: "system", content: system }, ...turns];
}

// Any status-bearing SDK error (APIError and its subclasses) gets rewrapped
// with the provider's label so error text stays consistent across providers
// regardless of which host actually rejected the request. A timeout has no
// status (the request never got a response at all), so it's matched by name
// instead — see ./timeout.js for why this guard exists.
function wrapError(err, label, timeoutMs) {
  if (err?.name === "APIConnectionTimeoutError") {
    return new Error(`${label} request timed out after ${timeoutMs}ms`);
  }
  if (err && typeof err.status === "number") {
    return new Error(`${label} error ${err.status}: ${err.message}`);
  }
  return err;
}

// Wraps any Chat Completions-compatible backend via the official `openai`
// SDK — real OpenAI, or a third-party host (Meta's Muse Spark, Groq,
// Together, ...) that speaks the same API. Only baseURL/apiKey/model/label
// differ between them; see ./openai.js and ./museSpark.js.
export function createOpenAiCompatibleProvider({
  apiKey,
  baseURL,
  model,
  label,
  createClient = (cfg) => new OpenAI(cfg),
  timeoutMs = REQUEST_TIMEOUT_MS,
  reasoningEffort,
}) {
  const client = createClient(baseURL ? { apiKey, baseURL } : { apiKey });
  // Sent only when set — hosts/models without reasoning support may reject it.
  const extra = reasoningEffort ? { reasoning_effort: reasoningEffort } : {};

  return {
    async streamReply({ system, messages, onText }) {
      let accumulated = "";
      try {
        const stream = await client.chat.completions.create(
          { model, stream: true, messages: toChatMessages(system, messages), ...extra },
          { timeout: timeoutMs },
        );
        for await (const chunk of stream) {
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            accumulated += delta;
            if (onText) onText(delta);
          }
        }
      } catch (err) {
        throw wrapError(err, label, timeoutMs);
      }
      return accumulated;
    },

    async complete({ system, prompt }) {
      try {
        const res = await client.chat.completions.create(
          { model, messages: toChatMessages(system, [{ role: "user", content: prompt }]), ...extra },
          { timeout: timeoutMs },
        );
        return res.choices?.[0]?.message?.content || "";
      } catch (err) {
        throw wrapError(err, label, timeoutMs);
      }
    },
  };
}
