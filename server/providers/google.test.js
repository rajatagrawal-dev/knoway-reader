import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleProvider } from "./google.js";

function fakeFetch(capture, respond) {
  return async (url, opts) => {
    capture.url = url;
    capture.opts = opts;
    return respond();
  };
}

const SSE = [
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Hello " }] } }] })}`,
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "world" }] } }] })}`,
].join("\n\n") + "\n\n";

test("streamReply posts to streamGenerateContent and streams text parts", async () => {
  const capture = {};
  const provider = createGoogleProvider({
    apiKey: "goog-test",
    model: "gemini-3-pro",
    fetchImpl: fakeFetch(capture, () => new Response(SSE, { status: 200 })),
  });

  const chunks = [];
  const full = await provider.streamReply({
    system: "SYS",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ],
    onText: (t) => chunks.push(t),
  });

  assert.equal(full, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.equal(
    capture.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse"
  );
  assert.equal(capture.opts.headers["x-goog-api-key"], "goog-test");
  const body = JSON.parse(capture.opts.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "first" }] },
    { role: "model", parts: [{ text: "reply" }] }, // assistant -> model
    { role: "user", parts: [{ text: "second" }] },
  ]);
});

test("streamReply attaches an image as inlineData", async () => {
  const capture = {};
  const provider = createGoogleProvider({
    apiKey: "goog-test",
    model: "gemini-3-pro",
    fetchImpl: fakeFetch(capture, () => new Response("data: {}\n\n", { status: 200 })),
  });
  await provider.streamReply({
    system: "SYS",
    messages: [{ role: "user", content: "what is this?", image: { mediaType: "image/png", data: "AAAA" } }],
    onText: () => {},
  });
  const body = JSON.parse(capture.opts.body);
  assert.deepEqual(body.contents, [
    {
      role: "user",
      parts: [{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data: "AAAA" } }],
    },
  ]);
});

test("complete calls generateContent (non-streaming) and joins text parts", async () => {
  const capture = {};
  const provider = createGoogleProvider({
    apiKey: "goog-test",
    model: "gemini-3-flash",
    fetchImpl: fakeFetch(capture, () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "quick answer" }] } }] }), {
        status: 200,
      })
    ),
  });
  const out = await provider.complete({ system: "G", prompt: "what is x?" });
  assert.equal(out, "quick answer");
  assert.equal(
    capture.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent"
  );
});

test("a non-ok response rejects with status and detail", async () => {
  const provider = createGoogleProvider({
    apiKey: "bad-key",
    model: "gemini-3-pro",
    fetchImpl: async () => new Response("API key not valid", { status: 400 }),
  });
  await assert.rejects(
    () => provider.complete({ system: "G", prompt: "x" }),
    /Gemini API error 400: API key not valid/
  );
});

test("a stream that opens fine but then never sends data or closes times out", async () => {
  // Regression test for the actual incident: Gemini returned 200 and opened
  // a stream during a "high demand" condition, then never sent another byte
  // and never closed the connection — streamReply hung forever with no
  // error. timeoutMs is short here so the test doesn't take the real 120s.
  const provider = createGoogleProvider({
    apiKey: "goog-test",
    model: "gemini-3-pro",
    timeoutMs: 20,
    fetchImpl: (url, opts) => {
      let controllerRef;
      const stream = new ReadableStream({
        start(controller) {
          controllerRef = controller;
        },
      });
      opts.signal.addEventListener("abort", () => controllerRef.error(new DOMException("aborted", "AbortError")));
      return Promise.resolve(new Response(stream, { status: 200 }));
    },
  });
  await assert.rejects(
    () => provider.streamReply({ system: "SYS", messages: [{ role: "user", content: "hi" }], onText: () => {} }),
    /Gemini API request timed out after 20ms/
  );
});

test("sends maxOutputTokens and reports the final usage, thinking included", async () => {
  const capture = {};
  const events = [
    { candidates: [{ content: { parts: [{ text: "a" }] } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 1 } },
    {
      candidates: [{ content: { parts: [{ text: "b" }] } }],
      usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, thoughtsTokenCount: 100, cachedContentTokenCount: 10 },
    },
  ];
  const provider = createGoogleProvider({
    apiKey: "g",
    model: "gemini-3-pro",
    maxTokens: 700,
    fetchImpl: fakeFetch(capture, () => new Response(events.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n")),
  });
  const usages = [];
  await provider.streamReply({ system: "S", messages: [{ role: "user", content: "p" }], onText: () => {}, onUsage: (u) => usages.push(u) });
  assert.deepEqual(JSON.parse(capture.opts.body).generationConfig, { maxOutputTokens: 700 + 8192 });
  assert.deepEqual(usages, [{ inputTokens: 50, cachedInputTokens: 10, outputTokens: 120 }]);
});

test("sends every image a message carries as inlineData parts", async () => {
  const capture = {};
  await createGoogleProvider({
    apiKey: "g",
    model: "gemini-3-pro",
    fetchImpl: fakeFetch(capture, () => new Response("", { status: 200 })),
  }).streamReply({
    system: "S",
    messages: [{ role: "user", content: "q", images: [{ mediaType: "image/jpeg", data: "A" }, { mediaType: "image/png", data: "B" }] }],
    onText: () => {},
  });
  const parts = JSON.parse(capture.opts.body).contents[0].parts;
  assert.deepEqual(parts, [{ text: "q" }, { inlineData: { mimeType: "image/jpeg", data: "A" } }, { inlineData: { mimeType: "image/png", data: "B" } }]);
});
