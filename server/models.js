import { createProvider } from "./providers/index.js";

// Dive and quick-meaning can each run through a different provider/model —
// e.g. dive on Claude for quality, quick meanings on a cheaper/faster
// model. Set DIVE_PROVIDER/DIVE_MODEL and QUICK_PROVIDER/QUICK_MODEL in
// .env per role. Supported providers: anthropic, openai, google,
// muse-spark (see ./providers/index.js). With nothing set, every role uses
// the Muse Spark API (MUSE_SPARK_API_KEY); the glossary role runs it at low
// reasoning effort since it must answer in real time.
//
// maxTokens caps each role's reply (override with {ROLE}_MAX_TOKENS). The
// caps are a backstop against runaway output, not the way answers are kept
// short — prompts do that. They leave room for a reasoning model's hidden
// reasoning, which most providers count against the same cap.
const ROLE_DEFAULTS = {
  DIVE: { provider: "muse-spark", model: "muse-spark-1.3-contributor", maxTokens: 1024 },
  QUICK: { provider: "muse-spark", model: "muse-spark-1.3-contributor", maxTokens: 512 },
  GLOSSARY: { provider: "muse-spark", model: "muse-spark-1.3-contributor", reasoningEffort: "low", maxTokens: 1024 },
};

// Ask (whole-document questions) answers like a dive does, so unless
// ASK_PROVIDER/ASK_MODEL say otherwise it uses the dive role's provider and
// model — including any DIVE_ overrides in .env.
const INHERITS = { ASK: "DIVE" };

export function roleConfig(role, env = process.env) {
  const parent = INHERITS[role];
  const defaults = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS[parent];
  const maxTokens = Number.parseInt(env[`${role}_MAX_TOKENS`] ?? "", 10);
  return {
    provider: env[`${role}_PROVIDER`] || (parent && env[`${parent}_PROVIDER`]) || defaults.provider,
    model: env[`${role}_MODEL`] || (parent && env[`${parent}_MODEL`]) || defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    maxTokens: maxTokens > 0 ? maxTokens : defaults.maxTokens,
  };
}

function roleProvider(role) {
  const { provider, ...options } = roleConfig(role);
  return createProvider(provider, options);
}

// One line per model call with its token counts — how the context budgets
// are checked in practice. On in development; LOG_USAGE=1 turns it on in a
// production (packaged) server too.
export function usageLogger(role, { env = process.env, log = console.log } = {}) {
  if (env.NODE_ENV === "production" && env.LOG_USAGE !== "1") return undefined;
  return ({ inputTokens, cachedInputTokens, outputTokens }) => {
    const cached = cachedInputTokens ? ` (cached ${cachedInputTokens})` : "";
    log(`[usage] ${role}: in ${inputTokens}${cached}, out ${outputTokens}`);
  };
}

// A dive request's per-question system text (systemSuffix): a separate
// block for a provider that caches the part before it, otherwise appended.
export function withSystemSuffix(provider, { system, systemSuffix, ...rest }) {
  if (!systemSuffix) return { system, ...rest };
  return provider.supportsSystemSuffix ? { system, systemSuffix, ...rest } : { system: `${system}\n\n${systemSuffix}`, ...rest };
}

export function createDiveModels() {
  const dive = roleProvider("DIVE");
  const quick = roleProvider("QUICK");
  // Built on first use rather than at startup: its default provider needs
  // MUSE_SPARK_API_KEY, and a missing key should fail glossary requests
  // (with that error), not stop the server from starting for dives.
  let glossary = null;
  const ask = roleProvider("ASK");
  const onUsage = {
    dive: usageLogger("dive"),
    ask: usageLogger("ask"),
    quick: usageLogger("quick"),
    glossary: usageLogger("glossary"),
  };
  return {
    streamDiveReply: (args) => dive.streamReply({ ...withSystemSuffix(dive, args), onUsage: onUsage.dive }),
    streamAskReply: (args) => ask.streamReply({ ...args, onUsage: onUsage.ask }),
    quickAnswer: (args) => quick.complete({ ...args, onUsage: onUsage.quick }),
    streamGlossary: (args) => {
      glossary ??= roleProvider("GLOSSARY");
      return glossary.streamReply({ ...args, onUsage: onUsage.glossary });
    },
  };
}
