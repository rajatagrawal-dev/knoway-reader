import { createProvider } from "./providers/index.js";

// Dive and quick-meaning can each run through a different provider/model —
// e.g. dive on Claude for quality, quick meanings on a cheaper/faster
// model. Set DIVE_PROVIDER/DIVE_MODEL and QUICK_PROVIDER/QUICK_MODEL in
// .env per role. Supported providers: anthropic, anthropic-cli, openai,
// google, muse-spark (see ./providers/index.js). With nothing set, both
// roles default to the local `claude` CLI exactly as before — no API key
// required.
//
// The glossary role is the exception: it must answer in real time, so it
// defaults to the Muse Spark API at low reasoning effort rather than the
// CLI, whose per-request process spawn alone costs seconds.
const ROLE_DEFAULTS = {
  DIVE: { provider: "anthropic-cli", model: "claude-sonnet-5" },
  QUICK: { provider: "anthropic-cli", model: "claude-haiku-4-5-20251001" },
  GLOSSARY: { provider: "muse-spark", model: "muse-spark-1.3-contributor", reasoningEffort: "low" },
};

function roleProvider(role) {
  const defaults = ROLE_DEFAULTS[role];
  const provider = process.env[`${role}_PROVIDER`] || defaults.provider;
  const model = process.env[`${role}_MODEL`] || defaults.model;
  return createProvider(provider, { model, reasoningEffort: defaults.reasoningEffort });
}

export function createDiveModels() {
  const dive = roleProvider("DIVE");
  const quick = roleProvider("QUICK");
  // Built on first use rather than at startup: its default provider needs
  // MUSE_SPARK_API_KEY, and a missing key should fail glossary requests
  // (with that error), not stop the server from starting for dives.
  let glossary = null;
  return {
    streamDiveReply: (args) => dive.streamReply(args),
    quickAnswer: (args) => quick.complete(args),
    streamGlossary: (args) => {
      glossary ??= roleProvider("GLOSSARY");
      return glossary.streamReply(args);
    },
  };
}
