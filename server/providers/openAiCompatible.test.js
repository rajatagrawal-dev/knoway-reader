import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAiCompatibleProvider } from "./openAiCompatible.js";

// A fake OpenAI SDK client factory: records the constructor config it was
// built with and the params each chat.completions.create() call received.
function fakeClientFactory(capture, { streamChunks, completion, err } = {}) {
  return (cfg) => {
    capture.cfg = cfg;
    return {
      chat: {
        completions: {
          create: async (params, timeoutOpts) => {
            capture.params = params;
            capture.timeoutOpts = timeoutOpts;
            if (err) throw err;
            if (params.stream) {
              return (async function* () {
                for (const chunk of streamChunks) yield chunk;
              })();
            }
            return completion;
          },
        },
      },
    };
  };
}

test("streamReply builds the client from apiKey/baseURL and streams text deltas", async () => {
  const capture = {};
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    baseURL: "https://example.com/v1",
    model: "some-model",
    label: "Example API",
    createClient: fakeClientFactory(capture, {
      streamChunks: [
        { choices: [{ delta: { content: "Hello " } }] },
        { choices: [{ delta: { content: "world" } }] },
      ],
    }),
  });

  const chunks = [];
  const full = await provider.streamReply({
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
    onText: (t) => chunks.push(t),
  });

  assert.equal(full, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.deepEqual(capture.cfg, { apiKey: "sk-test", baseURL: "https://example.com/v1" });
  assert.equal(capture.params.model, "some-model");
  assert.equal(capture.params.stream, true);
  assert.deepEqual(capture.params.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "hi" },
  ]);
});

test("omits baseURL from the client config when none is given (real OpenAI default)", async () => {
  const capture = {};
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    model: "gpt-5",
    label: "OpenAI API",
    createClient: fakeClientFactory(capture, { completion: { choices: [{ message: { content: "ok" } }] } }),
  });
  await provider.complete({ system: "S", prompt: "hi" });
  assert.deepEqual(capture.cfg, { apiKey: "sk-test" });
});

test("streamReply attaches an image as image_url content", async () => {
  const capture = {};
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    model: "gpt-5",
    label: "OpenAI API",
    createClient: fakeClientFactory(capture, { streamChunks: [] }),
  });
  await provider.streamReply({
    system: "SYS",
    messages: [{ role: "user", content: "what is this?", image: { mediaType: "image/png", data: "AAAA" } }],
    onText: () => {},
  });
  assert.deepEqual(capture.params.messages[1], {
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  });
});

test("complete makes a non-streaming call and returns the message content", async () => {
  const capture = {};
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    model: "gpt-5-mini",
    label: "OpenAI API",
    createClient: fakeClientFactory(capture, {
      completion: { choices: [{ message: { content: "quick answer" } }] },
    }),
  });
  const out = await provider.complete({ system: "G", prompt: "what is x?" });
  assert.equal(out, "quick answer");
  assert.equal(capture.params.stream, undefined);
});

test("a status-bearing SDK error is rewrapped with the provider's label", async () => {
  const capture = {};
  const err = Object.assign(new Error("Incorrect API key provided"), { status: 401 });
  const provider = createOpenAiCompatibleProvider({
    apiKey: "bad-key",
    model: "gpt-5",
    label: "OpenAI API",
    createClient: fakeClientFactory(capture, { err }),
  });
  await assert.rejects(
    () => provider.complete({ system: "G", prompt: "x" }),
    /OpenAI API error 401: Incorrect API key provided/
  );
});

test("an error without a status code is rethrown as-is", async () => {
  const capture = {};
  const err = new TypeError("fetch failed");
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    model: "gpt-5",
    label: "OpenAI API",
    createClient: fakeClientFactory(capture, { err }),
  });
  await assert.rejects(() => provider.complete({ system: "G", prompt: "x" }), TypeError);
});

test("passes timeoutMs to the SDK call and labels a timeout error", async () => {
  // Regression test companion to anthropicApi/google's stalled-connection
  // tests: the SDK's own `timeout` option is what stops a stalled OpenAI
  // (or Muse Spark) connection from hanging forever — verify it's actually
  // threaded through, and that the SDK's timeout error (no status code, so
  // the generic "status N" wrapping doesn't apply) gets a clear message.
  const capture = {};
  const err = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
  const provider = createOpenAiCompatibleProvider({
    apiKey: "sk-test",
    model: "gpt-5",
    label: "OpenAI API",
    timeoutMs: 20,
    createClient: fakeClientFactory(capture, { err }),
  });
  await assert.rejects(
    () => provider.complete({ system: "G", prompt: "x" }),
    /OpenAI API request timed out after 20ms/
  );
  assert.equal(capture.timeoutOpts?.timeout, 20);
});

test("sends max_completion_tokens only when a cap is set", async () => {
  const withCap = {};
  await createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "L",
    maxTokens: 700,
    createClient: fakeClientFactory(withCap, { completion: { choices: [{ message: { content: "x" } }] } }),
  }).complete({ system: "S", prompt: "p" });
  // The answer cap plus headroom for reasoning (medium, when unset).
  assert.equal(withCap.params.max_completion_tokens, 700 + 8192);

  const without = {};
  await createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "L",
    createClient: fakeClientFactory(without, { completion: { choices: [{ message: { content: "x" } }] } }),
  }).complete({ system: "S", prompt: "p" });
  assert.equal("max_completion_tokens" in without.params, false);
});

test("reports usage: from the response, and from a stream only when opted in", async () => {
  const usage = { prompt_tokens: 900, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 512 } };
  const expected = { inputTokens: 900, cachedInputTokens: 512, outputTokens: 60 };

  const usages = [];
  await createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "L",
    createClient: fakeClientFactory({}, { completion: { choices: [{ message: { content: "x" } }], usage } }),
  }).complete({ system: "S", prompt: "p", onUsage: (u) => usages.push(u) });
  assert.deepEqual(usages, [expected]);

  for (const streamUsage of [false, true]) {
    const capture = {};
    const streamed = [];
    await createOpenAiCompatibleProvider({
      apiKey: "k",
      model: "m",
      label: "L",
      streamUsage,
      createClient: fakeClientFactory(capture, {
        streamChunks: [{ choices: [{ delta: { content: "x" } }] }, ...(streamUsage ? [{ choices: [], usage }] : [])],
      }),
    }).streamReply({ system: "S", messages: [{ role: "user", content: "p" }], onText: () => {}, onUsage: (u) => streamed.push(u) });
    assert.equal("stream_options" in capture.params, streamUsage);
    assert.deepEqual(streamed, streamUsage ? [expected] : []);
  }
});

test("a reasoning model's cap leaves room for its effort level's reasoning", async () => {
  const capture = {};
  await createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "L",
    maxTokens: 1024,
    reasoningEffort: "low",
    createClient: fakeClientFactory(capture, { completion: { choices: [{ message: { content: "x" } }] } }),
  }).complete({ system: "S", prompt: "p" });
  assert.equal(capture.params.max_completion_tokens, 1024 + 2048);
});

test("a reply cut off before any text is an error, not an empty answer", async () => {
  const provider = createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "Muse Spark API",
    createClient: fakeClientFactory({}, {
      streamChunks: [{ choices: [{ delta: {}, finish_reason: "length" }] }],
      completion: { choices: [{ message: { content: "" }, finish_reason: "length" }] },
    }),
  });
  await assert.rejects(
    provider.streamReply({ system: "S", messages: [{ role: "user", content: "p" }], onText: () => {} }),
    /whole token budget before answering/,
  );
  await assert.rejects(provider.complete({ system: "S", prompt: "p" }), /whole token budget before answering/);
});

test("sends every image a message carries as image_url parts", async () => {
  const capture = {};
  await createOpenAiCompatibleProvider({
    apiKey: "k",
    model: "m",
    label: "L",
    createClient: fakeClientFactory(capture, { streamChunks: [{ choices: [{ delta: { content: "x" } }] }] }),
  }).streamReply({
    system: "S",
    messages: [{ role: "user", content: "q", images: [{ mediaType: "image/jpeg", data: "A" }, { mediaType: "image/jpeg", data: "B" }] }],
    onText: () => {},
  });
  const parts = capture.params.messages[1].content;
  assert.deepEqual(parts.map((p) => p.type), ["text", "image_url", "image_url"]);
  assert.equal(parts[2].image_url.url, "data:image/jpeg;base64,B");
});
