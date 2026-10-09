import { createAnthropicApiProvider } from "./anthropicApi.js";
import { createOpenAiProvider } from "./openai.js";
import { createGoogleProvider } from "./google.js";
import { createMuseSparkProvider } from "./museSpark.js";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to your .env file to use this provider.`);
  }
  return value;
}

// Builds a { streamReply, complete } provider for one dive role. `name`
// selects the backend; each takes its model id via `model` (the .env var
// that supplies both is read by ../models.js, one role at a time).
// `reasoningEffort` is only honored by muse-spark, whose default otherwise
// applies. `maxTokens` caps the reply's output tokens on every provider.
export function createProvider(name, { model, reasoningEffort, maxTokens }) {
  switch (name) {
    case "anthropic":
      return createAnthropicApiProvider({ apiKey: requireEnv("ANTHROPIC_API_KEY"), model, maxTokens });
    case "openai":
      return createOpenAiProvider({ apiKey: requireEnv("OPENAI_API_KEY"), model, maxTokens });
    case "google":
      return createGoogleProvider({ apiKey: requireEnv("GOOGLE_API_KEY"), model, maxTokens });
    case "muse-spark":
      return createMuseSparkProvider({ apiKey: requireEnv("MUSE_SPARK_API_KEY"), model, reasoningEffort, maxTokens });
    default:
      throw new Error(
        `Unknown provider "${name}". Supported providers: anthropic, openai, google, muse-spark.`
      );
  }
}
