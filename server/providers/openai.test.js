import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiProvider } from "./openai.js";

test("uses the OpenAI API error label and no baseURL override", async () => {
  const capture = {};
  const provider = createOpenAiProvider({
    apiKey: "sk-test",
    model: "gpt-5",
    createClient: (cfg) => {
      capture.cfg = cfg;
      return {
        chat: {
          completions: {
            create: async () => {
              throw Object.assign(new Error("bad key"), { status: 401 });
            },
          },
        },
      };
    },
  });
  assert.deepEqual(capture.cfg, { apiKey: "sk-test" }); // no baseURL -> api.openai.com default
  await assert.rejects(() => provider.complete({ system: "S", prompt: "x" }), /OpenAI API error 401: bad key/);
});
