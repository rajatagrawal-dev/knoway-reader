import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

// OpenAI itself, via the official SDK's default baseURL (api.openai.com)
// and OPENAI_API_KEY.
export function createOpenAiProvider({ apiKey, model, createClient, timeoutMs }) {
  return createOpenAiCompatibleProvider({ apiKey, model, label: "OpenAI API", createClient, timeoutMs });
}
