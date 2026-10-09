import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

// Meta's Muse Spark, via the OpenAI SDK pointed at Meta's endpoint instead
// of api.openai.com (per https://dev.meta.ai/docs/sdks — Chat Completions,
// streaming, and vision are all supported through the OpenAI SDK the same
// way as real OpenAI). MUSE_SPARK_API_KEY is passed explicitly since the
// SDK only auto-reads OPENAI_API_KEY by default.
//
// NOTE: dev.meta.ai / api.meta.ai aren't domains this code has independently
// verified as Meta's real developer API host — confirm against Meta's own
// current developer docs before relying on this in production.
const MUSE_SPARK_BASE_URL = "https://api.meta.ai/v1";

// Medium keeps dive replies quicker to start — the reasoning phase isn't
// streamed to the UI, so a long one reads as the panel hanging. A role can
// pass its own (the glossary runs at "low" — see ../models.js).
const DEFAULT_REASONING_EFFORT = "medium";

export function createMuseSparkProvider({
  apiKey,
  model,
  createClient,
  timeoutMs,
  reasoningEffort = DEFAULT_REASONING_EFFORT,
  maxTokens,
}) {
  return createOpenAiCompatibleProvider({
    apiKey,
    baseURL: MUSE_SPARK_BASE_URL,
    model,
    label: "Muse Spark API",
    createClient,
    timeoutMs,
    reasoningEffort,
    maxTokens,
  });
}
