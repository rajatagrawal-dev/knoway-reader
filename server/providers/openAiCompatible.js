import OpenAI from "openai";
import { messageImages } from "./images.js";
import { REQUEST_TIMEOUT_MS } from "./timeout.js";

function toChatMessages(system, messages) {
  const turns = messages.map((m) => {
    const images = messageImages(m);
    return {
      role: m.role,
      content: images.length
        ? [
            { type: "text", text: m.content },
            ...images.map((image) => ({
              type: "image_url",
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
          ]
        : m.content,
    };
  });
  return [{ role: "system", content: system }, ...turns];
}

// Reasoning models think in hidden tokens before they answer, and
// max_completion_tokens counts those too. So the cap a role sets — the
// length of its *answer* — gets headroom for the reasoning its effort level
// implies; without it a medium-effort model can spend the whole budget
// thinking and return nothing at all. A model whose effort isn't set is
// assumed to reason at the usual default (medium). The cap stays what it's
// for: a backstop against runaway output, not the way answers are kept
// short (prompts do that).
export const REASONING_ALLOWANCE = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

export function completionCap(maxTokens, reasoningEffort) {
  if (!maxTokens) return undefined;
  return maxTokens + (REASONING_ALLOWANCE[reasoningEffort ?? "medium"] ?? REASONING_ALLOWANCE.medium);
}

// A reply cut off by the token cap before any visible text: an error the
// reader can act on, not an empty answer.
function emptyBecauseOfCap(label) {
  return new Error(`${label}: the model used its whole token budget before answering. Try again, or raise this role's _MAX_TOKENS.`);
}

// Token counts as every provider reports them to onUsage.
function toUsage(usage) {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  };
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
  maxTokens,
  streamUsage = false,
}) {
  const client = createClient(baseURL ? { apiKey, baseURL } : { apiKey });
  // Each sent only when set — hosts/models without reasoning support may
  // reject reasoning_effort. max_completion_tokens (OpenAI's current name
  // for the output cap) counts a reasoning model's hidden reasoning too, so
  // a role's cap must leave room for it.
  const cap = completionCap(maxTokens, reasoningEffort);
  const extra = {
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    ...(cap ? { max_completion_tokens: cap } : {}),
  };
  // Usage on a stream needs an opt-in that not every compatible host
  // accepts, so it's per provider (see ./openai.js).
  const streamExtra = streamUsage ? { stream_options: { include_usage: true } } : {};

  return {
    async streamReply({ system, messages, onText, onUsage }) {
      let accumulated = "";
      try {
        const stream = await client.chat.completions.create(
          { model, stream: true, messages: toChatMessages(system, messages), ...extra, ...streamExtra },
          { timeout: timeoutMs },
        );
        let finishReason = null;
        for await (const chunk of stream) {
          finishReason = chunk.choices?.[0]?.finish_reason ?? finishReason;
          if (chunk.usage && onUsage) onUsage(toUsage(chunk.usage));
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string") {
            accumulated += delta;
            if (onText) onText(delta);
          }
        }
        if (!accumulated.trim() && finishReason === "length") throw emptyBecauseOfCap(label);
      } catch (err) {
        throw wrapError(err, label, timeoutMs);
      }
      return accumulated;
    },

    async complete({ system, prompt, onUsage }) {
      try {
        const res = await client.chat.completions.create(
          { model, messages: toChatMessages(system, [{ role: "user", content: prompt }]), ...extra },
          { timeout: timeoutMs },
        );
        if (res.usage && onUsage) onUsage(toUsage(res.usage));
        const content = res.choices?.[0]?.message?.content || "";
        if (!content.trim() && res.choices?.[0]?.finish_reason === "length") throw emptyBecauseOfCap(label);
        return content;
      } catch (err) {
        throw wrapError(err, label, timeoutMs);
      }
    },
  };
}
