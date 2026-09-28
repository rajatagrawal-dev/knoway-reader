import test from "node:test";
import assert from "node:assert/strict";
import { createMuseSparkProvider } from "./museSpark.js";

test("points the OpenAI SDK at Meta's Muse Spark endpoint", async () => {
  const capture = {};
  const provider = createMuseSparkProvider({
    apiKey: "muse-key",
    model: "muse-spark-1.3",
    createClient: (cfg) => {
      capture.cfg = cfg;
      return {
        chat: {
          completions: {
            create: async (params) => {
              capture.params = params;
              return { choices: [{ message: { content: "ok" } }] };
            },
          },
        },
      };
    },
  });
  assert.deepEqual(capture.cfg, { apiKey: "muse-key", baseURL: "https://api.meta.ai/v1" });

  const out = await provider.complete({ system: "S", prompt: "hi" });
  assert.equal(out, "ok");
  assert.equal(capture.params.model, "muse-spark-1.3");
  assert.equal(capture.params.reasoning_effort, "medium");
});

test("uses the Muse Spark API error label", async () => {
  const provider = createMuseSparkProvider({
    apiKey: "bad-key",
    model: "muse-spark-1.3",
    createClient: () => ({
      chat: {
        completions: {
          create: async () => {
            throw Object.assign(new Error("invalid key"), { status: 401 });
          },
        },
      },
    }),
  });
  await assert.rejects(
    () => provider.complete({ system: "S", prompt: "x" }),
    /Muse Spark API error 401: invalid key/
  );
});

test("a role can override the reasoning effort", async () => {
  const capture = {};
  const provider = createMuseSparkProvider({
    apiKey: "muse-key",
    model: "muse-spark-1.3",
    reasoningEffort: "low",
    createClient: () => ({
      chat: {
        completions: {
          create: async (params) => {
            capture.params = params;
            return { choices: [{ message: { content: "ok" } }] };
          },
        },
      },
    }),
  });
  await provider.complete({ system: "S", prompt: "hi" });
  assert.equal(capture.params.reasoning_effort, "low");
});
