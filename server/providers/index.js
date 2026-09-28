import { createAnthropicApiProvider } from "./anthropicApi.js";
import { createAnthropicCliProvider } from "./anthropicCli.js";
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
// applies.
export function createProvider(name, { model, reasoningEffort }) {
  switch (name) {
    case "anthropic":
      return createAnthropicApiProvider({ apiKey: requireEnv("ANTHROPIC_API_KEY"), model });
    case "anthropic-cli":
      return createAnthropicCliProvider({ model });
    case "openai":
      return createOpenAiProvider({ apiKey: requireEnv("OPENAI_API_KEY"), model });
    case "google":
      return createGoogleProvider({ apiKey: requireEnv("GOOGLE_API_KEY"), model });
    case "muse-spark":
      return createMuseSparkProvider({ apiKey: requireEnv("MUSE_SPARK_API_KEY"), model, reasoningEffort });
    default:
      throw new Error(
        `Unknown provider "${name}". Supported providers: anthropic, anthropic-cli, openai, google, muse-spark.`
      );
  }
}
