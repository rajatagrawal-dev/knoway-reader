import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

// OpenAI itself, via the official SDK's default baseURL (api.openai.com)
// and OPENAI_API_KEY. Reports usage on streams too.
export function createOpenAiProvider({ apiKey, model, maxTokens, createClient, timeoutMs }) {
  return createOpenAiCompatibleProvider({
    apiKey,
    model,
    maxTokens,
    label: "OpenAI API",
    createClient,
    timeoutMs,
    streamUsage: true,
  });
}
