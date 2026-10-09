import test from "node:test";
import assert from "node:assert/strict";
import { roleConfig, usageLogger } from "./models.js";

test("each role has its own output cap, overridable from the environment", () => {
  assert.equal(roleConfig("QUICK", {}).maxTokens, 512);
  assert.equal(roleConfig("DIVE", {}).maxTokens, 1024);
  assert.equal(roleConfig("DIVE", { DIVE_MAX_TOKENS: "900" }).maxTokens, 900);
  assert.equal(roleConfig("DIVE", { DIVE_MAX_TOKENS: "nonsense" }).maxTokens, 1024);
  assert.deepEqual(roleConfig("GLOSSARY", { GLOSSARY_PROVIDER: "openai", GLOSSARY_MODEL: "x" }), {
    provider: "openai",
    model: "x",
    reasoningEffort: "low",
    maxTokens: 1024,
  });
});

test("usage is logged in development, and in production only when asked", () => {
  const lines = [];
  const log = (line) => lines.push(line);
  usageLogger("dive", { env: {}, log })({ inputTokens: 1500, cachedInputTokens: 1000, outputTokens: 80 });
  usageLogger("quick", { env: {}, log })({ inputTokens: 300, cachedInputTokens: 0, outputTokens: 20 });
  assert.deepEqual(lines, ["[usage] dive: in 1500 (cached 1000), out 80", "[usage] quick: in 300, out 20"]);
  assert.equal(usageLogger("dive", { env: { NODE_ENV: "production" }, log }), undefined);
  assert.equal(typeof usageLogger("dive", { env: { NODE_ENV: "production", LOG_USAGE: "1" }, log }), "function");
});

test("Ask uses the dive role's provider and model unless told otherwise", () => {
  assert.deepEqual(roleConfig("ASK", {}), roleConfig("DIVE", {}));
  const env = { DIVE_PROVIDER: "muse-spark", DIVE_MODEL: "m1" };
  assert.equal(roleConfig("ASK", env).provider, "muse-spark");
  assert.equal(roleConfig("ASK", env).model, "m1");
  assert.equal(roleConfig("ASK", { ...env, ASK_PROVIDER: "openai", ASK_MODEL: "m2" }).provider, "openai");
  assert.equal(roleConfig("ASK", { ...env, ASK_MAX_TOKENS: "600" }).maxTokens, 600);
});

test("withSystemSuffix appends the suffix for providers that can't take it apart", async () => {
  const { withSystemSuffix } = await import("./models.js");
  assert.deepEqual(withSystemSuffix({}, { system: "S", systemSuffix: "X", messages: [] }), { system: "S\n\nX", messages: [] });
  assert.deepEqual(withSystemSuffix({ supportsSystemSuffix: true }, { system: "S", systemSuffix: "X" }), { system: "S", systemSuffix: "X" });
  assert.deepEqual(withSystemSuffix({}, { system: "S", systemSuffix: "" }), { system: "S" });
});
