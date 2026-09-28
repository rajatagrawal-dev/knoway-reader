import test from "node:test";
import assert from "node:assert/strict";
import { createAnthropicApiProvider } from "./anthropicApi.js";

function fakeFetch(capture, respond) {
  return async (url, opts) => {
    capture.url = url;
    capture.opts = opts;
    return respond();
  };
}

const SSE = [
  `data: ${JSON.stringify({ type: "message_start" })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } })}`,
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } })}`,
  `data: ${JSON.stringify({ type: "message_stop" })}`,
].join("\n\n") + "\n\n";

test("streamReply posts to the Messages API and streams text deltas", async () => {
  const capture = {};
  const provider = createAnthropicApiProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-5",
    fetchImpl: fakeFetch(capture, () => new Response(SSE, { status: 200 })),
  });

  const chunks = [];
  const full = await provider.streamReply({
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
    onText: (t) => chunks.push(t),
  });

  assert.equal(full, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.equal(capture.url, "https://api.anthropic.com/v1/messages");
  assert.equal(capture.opts.headers["x-api-key"], "sk-ant-test");
  assert.equal(capture.opts.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(capture.opts.body);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.system, "SYS");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("streamReply attaches an image as a content block", async () => {
  const capture = {};
  const provider = createAnthropicApiProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-5",
    fetchImpl: fakeFetch(capture, () => new Response("data: {\"type\":\"message_stop\"}\n\n", { status: 200 })),
  });
  await provider.streamReply({
    system: "SYS",
    messages: [{ role: "user", content: "what is this?", image: { mediaType: "image/png", data: "AAAA" } }],
    onText: () => {},
  });
  const body = JSON.parse(capture.opts.body);
  assert.deepEqual(body.messages, [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    },
  ]);
});

test("complete makes a blocking call and returns the text block", async () => {
  const capture = {};
  const provider = createAnthropicApiProvider({
    apiKey: "sk-ant-test",
    model: "claude-haiku-4-5-20251001",
    fetchImpl: fakeFetch(capture, () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "quick answer" }] }), { status: 200 })
    ),
  });
  const out = await provider.complete({ system: "G", prompt: "what is x?" });
  assert.equal(out, "quick answer");
  const body = JSON.parse(capture.opts.body);
  assert.equal(body.stream, undefined);
  assert.deepEqual(body.messages, [{ role: "user", content: "what is x?" }]);
});

test("a non-ok response rejects with status and detail", async () => {
  const provider = createAnthropicApiProvider({
    apiKey: "bad-key",
    model: "claude-sonnet-5",
    fetchImpl: async () => new Response("invalid x-api-key", { status: 401 }),
  });
  await assert.rejects(
    () => provider.complete({ system: "G", prompt: "x" }),
    /Anthropic API error 401: invalid x-api-key/
  );
});

test("a stalled connection times out instead of hanging forever", async () => {
  // Regression test: Gemini was observed opening a stream during a "high
  // demand" condition and then never sending data or closing it, hanging
  // the request forever with no error. Every fetch-based provider now
  // aborts after timeoutMs — verified here with a fetch that honors the
  // abort signal but otherwise never resolves on its own, and a short
  // timeoutMs so the test doesn't take the real 120s default.
  const provider = createAnthropicApiProvider({
    apiKey: "sk-ant-test",
    model: "claude-sonnet-5",
    timeoutMs: 20,
    fetchImpl: (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  });
  await assert.rejects(
    () => provider.complete({ system: "G", prompt: "x" }),
    /Anthropic API request timed out after 20ms/
  );
});
