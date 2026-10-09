import test from "node:test";
import assert from "node:assert/strict";
import { buildApp, MAX_INPUT_CHARS } from "./app.js";

const fakeModels = {
  async streamAskReply({ onText }) {
    onText("Answer [S1]");
    return "Answer [S1]";
  },
  async streamDiveReply({ onText }) {
    onText("Hello ");
    onText("dive");
    return "Hello dive";
  },
  async quickAnswer() {
    return "Quick answer.";
  },
  async streamGlossary({ system, messages, onText }) {
    onText(`${system}|`);
    onText(messages[0].content);
    return `${system}|${messages[0].content}`;
  },
};

function parseSSE(text) {
  return text
    .split("\n\n")
    .filter((c) => c.startsWith("data: "))
    .map((c) => JSON.parse(c.slice(6)));
}

async function withServer(models, fn) {
  const app = buildApp({ models });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

test("GET /api/health returns ok", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

test("POST /api/dive/stream requires system and messages", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/dive/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/dive/stream streams text deltas then a done frame", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/dive/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const frames = parseSSE(await res.text());
    assert.deepEqual(
      frames.filter((f) => f.text !== undefined && !f.done),
      [{ text: "Hello " }, { text: "dive" }]
    );
    assert.equal(frames.at(-1).done, true);
    assert.equal(frames.at(-1).text, "Hello dive");
  });
});

test("POST /api/dive/stream sends an error frame instead of crashing when the model rejects", async () => {
  const failingModels = {
    async streamDiveReply() {
      throw new Error("model unavailable");
    },
    async quickAnswer() {
      throw new Error("unused");
    },
  };
  await withServer(failingModels, async (base) => {
    const res = await fetch(`${base}/api/dive/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    const frames = parseSSE(await res.text());
    assert.deepEqual(frames, [{ error: "model unavailable" }]);
  });
});

test("POST /api/dive/quick requires system and prompt", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/dive/quick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S" }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/dive/quick returns the answer", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/dive/quick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", prompt: "what is x?" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { answer: "Quick answer." });
  });
});

test("allows the packaged app's tauri:// origin and answers its preflight", async () => {
  await withServer(fakeModels, async (base) => {
    const preflight = await fetch(`${base}/api/dive/quick`, {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "tauri://localhost");

    const res = await fetch(`${base}/api/dive/quick`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "tauri://localhost" },
      body: JSON.stringify({ system: "S", prompt: "x" }),
    });
    assert.equal(res.headers.get("access-control-allow-origin"), "tauri://localhost");
    assert.equal(res.status, 200);
  });
});

test("does not set CORS headers for an unrecognized origin", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/health`, { headers: { Origin: "https://evil.example" } });
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });
});

test("POST /api/dive/quick returns 502 when the model rejects", async () => {
  const failingModels = {
    async streamDiveReply() { throw new Error("unused"); },
    async quickAnswer() { throw new Error("boom"); },
  };
  await withServer(failingModels, async (base) => {
    const res = await fetch(`${base}/api/dive/quick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", prompt: "x" }),
    });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "boom" });
  });
});

test("POST /api/glossary/stream requires system and prompt", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/glossary/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S" }),
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/glossary/stream streams the reply to the prompt as a single user turn", async () => {
  await withServer(fakeModels, async (base) => {
    const res = await fetch(`${base}/api/glossary/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", prompt: "qubit" }),
    });
    assert.equal(res.status, 200);
    const frames = parseSSE(await res.text());
    assert.deepEqual(frames, [{ text: "S|" }, { text: "qubit" }, { done: true, text: "S|qubit" }]);
  });
});

test("POST /api/glossary/stream sends an error frame when the model rejects", async () => {
  const failingModels = {
    ...fakeModels,
    async streamGlossary() {
      throw new Error("MUSE_SPARK_API_KEY is not set.");
    },
  };
  await withServer(failingModels, async (base) => {
    const res = await fetch(`${base}/api/glossary/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", prompt: "x" }),
    });
    assert.deepEqual(parseSSE(await res.text()), [{ error: "MUSE_SPARK_API_KEY is not set." }]);
  });
});

test("rejects requests over the input cap without calling the model", async () => {
  let called = false;
  const spy = {
    streamDiveReply: async () => ((called = true), ""),
    quickAnswer: async () => ((called = true), ""),
    streamGlossary: async () => ((called = true), ""),
  };
  const huge = "x".repeat(MAX_INPUT_CHARS);
  await withServer(spy, async (base) => {
    const post = (path, body) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const dive = await post("/api/dive/stream", { system: "S", messages: [{ role: "user", content: huge }] });
    assert.equal(dive.status, 413);
    assert.match((await dive.json()).error, /too large/);
    assert.equal((await post("/api/glossary/stream", { system: huge, prompt: "p" })).status, 413);
    assert.equal((await post("/api/dive/quick", { system: "S", prompt: huge })).status, 413);
    assert.equal(called, false);
    // Just under the cap still goes through.
    const ok = await post("/api/dive/quick", { system: "S", prompt: "x".repeat(MAX_INPUT_CHARS - 1) });
    assert.equal(ok.status, 200);
  });
  assert.equal(called, true);
});

test("POST /api/ask/stream streams the answer and validates its input", async () => {
  await withServer(fakeModels, async (base) => {
    const post = (body) =>
      fetch(`${base}/api/ask/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ system: "S" })).status, 400);
    const frames = parseSSE(await (await post({ system: "S", messages: [{ role: "user", content: "q" }] })).text());
    assert.deepEqual(frames[frames.length - 1], { done: true, text: "Answer [S1]" });
    assert.equal((await post({ system: "x".repeat(MAX_INPUT_CHARS + 1), messages: [{ role: "user", content: "q" }] })).status, 413);
  });
});

test("POST /api/glossary/stream passes an attached image through", async () => {
  let received = null;
  const spy = { ...fakeModels, streamGlossary: async ({ messages, onText }) => ((received = messages), onText("x"), "x") };
  await withServer(spy, async (base) => {
    await fetch(`${base}/api/glossary/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system: "S", prompt: "P", images: [{ mediaType: "image/png", data: "A" }] }),
    }).then((r) => r.text());
  });
  assert.deepEqual(received, [{ role: "user", content: "P", images: [{ mediaType: "image/png", data: "A" }] }]);
});

test("GET /api/reference returns the lookup, or empty results when it can't help", async () => {
  const lookupReference = async (term) => ({ dictionary: null, encyclopedia: [{ title: term, extract: "x", url: "u" }] });
  const app = buildApp({ models: fakeModels, lookupReference });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(`${base}/api/reference?term=${encodeURIComponent("ad hoc")}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).encyclopedia[0].title, "ad hoc");

    res = await fetch(`${base}/api/reference?term=${encodeURIComponent("one two three four five six seven")}`);
    assert.deepEqual(await res.json(), { dictionary: null, encyclopedia: [] });

    res = await fetch(`${base}/api/reference`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /api/dive/stream passes a systemSuffix through and counts it toward the cap", async () => {
  const calls = [];
  const models = {
    async streamDiveReply(args) {
      calls.push(args);
      return "ok";
    },
  };
  await withServer(models, async (base) => {
    const post = (body) =>
      fetch(`${base}/api/dive/stream`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await (await post({ system: "S", systemSuffix: "More sources", messages: [{ role: "user", content: "hi" }] })).text();
    await (await post({ system: "S", messages: [{ role: "user", content: "hi" }] })).text();
    const huge = await post({ system: "S", systemSuffix: "x".repeat(MAX_INPUT_CHARS), messages: [{ role: "user", content: "hi" }] });
    assert.equal(huge.status, 413);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].systemSuffix, "More sources");
  assert.equal("systemSuffix" in calls[1], false);
});
