import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";

const fakeModels = {
  async streamDiveReply({ onText }) {
    onText("Hello ");
    onText("dive");
    return "Hello dive";
  },
  async quickAnswer() {
    return "Quick answer.";
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
      throw new Error("claude CLI not found");
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
    assert.deepEqual(frames, [{ error: "claude CLI not found" }]);
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
