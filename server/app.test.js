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
