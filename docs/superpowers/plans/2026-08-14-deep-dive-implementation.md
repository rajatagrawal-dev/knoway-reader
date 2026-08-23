# Deep Dive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port LearningApp's tree-of-panels Deep Dive feature into PdfHighlighterApp as a two-pane sliding split view (PDF + active dive chain), backed by a thin stateless `claude`-CLI proxy server.

**Architecture:** A stateless Express backend (`server/`) spawns the local `claude` CLI per request and streams/returns replies; the entire dive tree and pins live client-side in `localStorage` (same pattern as existing highlights). The frontend gets a new `src/deepdive/` module (types, tree helpers, persistence, prompts, API client, and UI components) plus targeted edits to `App.tsx`, `ExpandableTip.tsx`, `HighlightContainer.tsx`, and `Sidebar.tsx`.

**Tech Stack:** Express + `node:child_process` (backend, plain JS, tested with `node --test`), React + TypeScript (frontend, existing Vite toolchain), `react-pdf-highlighter-plus` text extraction APIs, SSE for streaming.

Reference: `docs/superpowers/specs/2026-08-14-deep-dive-design.md` (this repo) is the approved spec — every task below implements a specific section of it.

## Global Constraints

- Backend is **stateless** — no session store, no file persistence. The dive tree lives only in the browser (spec §3.1).
- `DIVE_MODEL` defaults to `claude-sonnet-5`; `QUICK_MODEL` defaults to `claude-haiku-4-5-20251001`; both env-overridable (spec §3.1).
- `CLAUDE_BIN` defaults to `claude`; the CLI must be installed and logged in (rides the user's Claude subscription, no `ANTHROPIC_API_KEY`) (spec §3.1).
- No new frontend test framework — frontend verification is `tsc -b` + `vite build` + `oxlint` + manual Playwright walkthrough (spec §10). Backend uses Node's built-in `node --test` (zero new dependency), mirroring LearningApp's exact tested pattern for its CLI wrapper and Express routes.
- Persistence keys: `pdf-dives:<name>:<size>:<mtime>` and `pdf-pins:<name>:<size>:<mtime>`, alongside the existing `pdf-highlights:...` key (spec §4.1).
- `CommentedHighlight` gains one optional field: `divePanelId?: string` (spec §4).
- Root dive context = selected phrase + current-page + previous-page PDF text. Nested dive context = selected phrase + the full text of the specific panel turn it was selected from (spec §6).
- Deep Dive mode is entered/exited via `diveFocusId: string | null` in `App.tsx`; `null` renders today's unchanged sidebar+PDF view (spec §7.1).
- The pane window is always the last 2 entries of the current ancestor chain (spec §7.3).

---

### Task 1: Backend CLI wrapper (`server/claude.js`)

**Files:**
- Create: `server/claude.js`
- Test: `server/claude.test.js`

**Interfaces:**
- Produces: `createDiveModels(spawnImpl = spawn)` returning `{ streamDiveReply({system, messages, onText}): Promise<string>, quickAnswer({system, prompt}): Promise<string> }`. `messages` is `{role: "user"|"assistant", content: string}[]`. Later tasks (Task 2) consume this factory.

This is a direct port of LearningApp's `lib/models.js` (already proven and tested there), renaming `TEACH_MODEL`→`DIVE_MODEL`, `FAST_MODEL`→`QUICK_MODEL`, `streamTeachingReply`→`streamDiveReply`, `createModels`→`createDiveModels`, with new model defaults.

- [x] **Step 1: Write the failing tests**

Create `server/claude.test.js`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createDiveModels } from "./claude.js";

// A fake `spawn` that records the invocation and emits canned stdout lines,
// then closes with exit code 0 — no real process, no CLI, no auth needed.
function fakeSpawn(capture, lines) {
  return (cmd, args, opts) => {
    capture.cmd = cmd;
    capture.args = args;
    capture.opts = opts;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      for (const line of lines) child.stdout.emit("data", Buffer.from(line + "\n"));
      child.emit("close", 0);
    });
    return child;
  };
}

test("streamDiveReply invokes the CLI, streams text deltas, returns result", async () => {
  const capture = {};
  const lines = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello " } },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
    }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Hello world" }),
  ];
  const models = createDiveModels(fakeSpawn(capture, lines));

  const chunks = [];
  const full = await models.streamDiveReply({
    system: "SYS",
    messages: [{ role: "user", content: "hi" }],
    onText: (t) => chunks.push(t),
  });

  assert.equal(full, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]); // thinking_delta is not forwarded
  assert.equal(capture.cmd, process.env.CLAUDE_BIN || "claude");
  const a = capture.args;
  assert.ok(a.includes("--model"));
  assert.equal(a[a.indexOf("--model") + 1], process.env.DIVE_MODEL || "claude-sonnet-5");
  assert.equal(a[a.indexOf("--system-prompt") + 1], "SYS");
  assert.ok(a.includes("stream-json"));
  assert.ok(a.includes("--include-partial-messages"));
  assert.ok(a.includes("--no-session-persistence"));
  assert.equal(a[a.indexOf("--setting-sources") + 1], "project");
  assert.equal(a[a.length - 1], "hi"); // prompt is the final positional arg
  assert.equal(capture.opts.env.ANTHROPIC_API_KEY, undefined); // key stripped
});

test("streamDiveReply flattens multi-turn history into the prompt", async () => {
  const capture = {};
  const models = createDiveModels(
    fakeSpawn(capture, [JSON.stringify({ type: "result", is_error: false, result: "ok" })])
  );
  await models.streamDiveReply({
    system: "S",
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ],
    onText: () => {},
  });
  const prompt = capture.args[capture.args.length - 1];
  assert.match(prompt, /Previous conversation:/);
  assert.match(prompt, /User: first/);
  assert.match(prompt, /Assistant: reply/);
  assert.match(prompt, /User: second/);
});

test("quickAnswer uses the quick model with blocking json output", async () => {
  const capture = {};
  const lines = [
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "quick answer" }),
  ];
  const models = createDiveModels(fakeSpawn(capture, lines));

  const out = await models.quickAnswer({ system: "G", prompt: "what is x?" });
  assert.equal(out, "quick answer");
  const a = capture.args;
  assert.equal(a[a.indexOf("--model") + 1], process.env.QUICK_MODEL || "claude-haiku-4-5-20251001");
  assert.equal(a[a.indexOf("--output-format") + 1], "json");
  assert.ok(!a.includes("stream-json"));
  assert.equal(a[a.length - 1], "what is x?");
});

test("a CLI error result rejects", async () => {
  const capture = {};
  const models = createDiveModels(
    fakeSpawn(capture, [JSON.stringify({ type: "result", is_error: true, result: "boom" })])
  );
  await assert.rejects(() => models.quickAnswer({ system: "G", prompt: "x" }), /boom/);
});

test("streamDiveReply rejects (does not crash) on a CLI error result", async () => {
  const capture = {};
  const lines = [
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial " } },
    }),
    JSON.stringify({
      type: "result",
      is_error: true,
      result: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    }),
  ];
  const models = createDiveModels(fakeSpawn(capture, lines));
  await assert.rejects(
    () => models.streamDiveReply({ system: "S", messages: [{ role: "user", content: "hi" }], onText: () => {} }),
    /401 Invalid authentication credentials/
  );
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test server/claude.test.js`
Expected: FAIL — `server/claude.js` does not exist yet (`Cannot find module`).

- [x] **Step 3: Write the implementation**

Create `server/claude.js`:

```js
import { spawn } from "node:child_process";
import os from "node:os";

// PdfHighlighterApp talks to Claude through the local `claude` CLI (Claude Code),
// not the HTTP API — so it uses your Claude subscription auth instead of an
// ANTHROPIC_API_KEY / API credits. Dive replies stream token-by-token via
// stream-json; quick-meaning answers are a single blocking call.

const DIVE_MODEL = process.env.DIVE_MODEL || "claude-sonnet-5";
const QUICK_MODEL = process.env.QUICK_MODEL || "claude-haiku-4-5-20251001";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

// `--setting-sources project` + a neutral cwd keeps the CLI's own auth while
// skipping user-level hooks/plugins (e.g. a global SessionStart hook that would
// otherwise inject thousands of tokens of unrelated context into every turn).
const BASE_ARGS = [
  "-p",
  "--setting-sources", "project",
  "--no-session-persistence",
];

// Render a message list into a single prompt string for the CLI (which takes
// one prompt + a system prompt, not a messages array). The dive context lives
// in the system prompt; this is just the conversation transcript.
function messagesToPrompt(messages) {
  if (!messages || messages.length === 0) return "";
  if (messages.length === 1) return messages[0].content;
  const history = messages
    .slice(0, -1)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  const last = messages[messages.length - 1].content;
  return `Previous conversation:\n\n${history}\n\nUser: ${last}`;
}

// Spawn the claude CLI. Streams stdout to onLine(line) for newline-delimited
// output; resolves with the collected stdout string. Rejects on spawn error,
// non-zero exit, or timeout.
function runClaude(spawnImpl, { args, onLine, timeout }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // force the CLI to use its own subscription auth

    let proc;
    try {
      proc = spawnImpl(CLAUDE_BIN, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: os.tmpdir(),
        env,
      });
    } catch (err) {
      return reject(err);
    }

    const errChunks = [];
    let out = "";
    let buf = "";
    let timer = null;
    let settled = false;

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    if (timeout) {
      timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        done(reject, new Error(`claude CLI timed out after ${timeout}ms`));
      }, timeout);
    }

    proc.stdout.on("data", (d) => {
      if (settled) return;
      const s = d.toString();
      out += s;
      if (!onLine) return;
      buf += s;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          onLine(line);
        } catch (err) {
          try { proc.kill("SIGKILL"); } catch { /* already gone */ }
          return done(reject, err);
        }
      }
    });

    proc.stderr.on("data", (d) => errChunks.push(d));

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        return done(
          reject,
          new Error("Claude CLI not found. Install `claude` and run `claude` once to log in.")
        );
      }
      done(reject, err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      if (onLine && buf.trim()) {
        try {
          onLine(buf); // flush any trailing partial line
        } catch (err) {
          return done(reject, err);
        }
      }
      if (code !== 0) {
        const detail = Buffer.concat(errChunks).toString().trim();
        return done(reject, new Error(`claude CLI exited ${code}${detail ? `: ${detail}` : ""}`));
      }
      done(resolve, out);
    });
  });
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function createDiveModels(spawnImpl = spawn) {
  return {
    // Streams the dive model. Forwards each text delta to onText; resolves
    // with the full assistant text (thinking is excluded, matching the API path).
    async streamDiveReply({ system, messages, onText }) {
      const args = [
        ...BASE_ARGS,
        "--system-prompt", system,
        "--model", DIVE_MODEL,
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
        messagesToPrompt(messages),
      ];

      let result = null;
      let accumulated = "";

      await runClaude(spawnImpl, {
        args,
        timeout: 300_000,
        onLine: (line) => {
          const obj = parseLine(line);
          if (!obj) return;
          if (obj.type === "stream_event") {
            const ev = obj.event || {};
            if (
              ev.type === "content_block_delta" &&
              ev.delta &&
              ev.delta.type === "text_delta" &&
              typeof ev.delta.text === "string"
            ) {
              accumulated += ev.delta.text;
              if (onText) onText(ev.delta.text);
            }
          } else if (obj.type === "result") {
            if (obj.is_error) {
              throw new Error(obj.result || "Claude CLI returned an error.");
            }
            if (typeof obj.result === "string") result = obj.result;
          }
        },
      });

      return result != null ? result : accumulated;
    },

    // One blocking call to the quick model. Returns the reply text.
    async quickAnswer({ system, prompt }) {
      const args = [
        ...BASE_ARGS,
        "--system-prompt", system,
        "--model", QUICK_MODEL,
        "--output-format", "json",
        prompt,
      ];

      const stdout = await runClaude(spawnImpl, { args, timeout: 60_000 });
      const obj = parseLine(stdout.trim());
      if (!obj) throw new Error("Failed to parse claude CLI output as JSON.");
      if (obj.is_error) throw new Error(obj.result || "Claude CLI returned an error.");
      return typeof obj.result === "string" ? obj.result : "";
    },
  };
}

const defaultModels = createDiveModels();
export const streamDiveReply = (args) => defaultModels.streamDiveReply(args);
export const quickAnswer = (args) => defaultModels.quickAnswer(args);
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test server/claude.test.js`
Expected: all 5 tests PASS.

- [x] **Step 5: Commit**

```bash
git add server/claude.js server/claude.test.js
git commit -m "feat: add claude CLI wrapper for Deep Dive replies"
```

---

### Task 2: Backend Express app (`server/app.js`)

**Files:**
- Create: `server/app.js`
- Test: `server/app.test.js`

**Interfaces:**
- Consumes: `createDiveModels` shape from Task 1 — `{ streamDiveReply({system, messages, onText}): Promise<string>, quickAnswer({system, prompt}): Promise<string> }`.
- Produces: `buildApp({ models })` returning an Express `app` with `GET /api/health`, `POST /api/dive/stream` (SSE), `POST /api/dive/quick` (JSON). Task 3 consumes `buildApp` directly.

- [x] **Step 1: Write the failing tests**

Create `server/app.test.js`:

```js
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
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test server/app.test.js`
Expected: FAIL — `server/app.js` does not exist yet.

- [x] **Step 3: Write the implementation**

Create `server/app.js`:

```js
import express from "express";

// Stateless by design: the dive tree lives in the browser (localStorage), so
// this server has nothing to persist — it's purely an LLM proxy.
export function buildApp({ models }) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/dive/stream", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!system || !messages || messages.length === 0) {
      return res.status(400).json({ error: "system and a non-empty messages array are required." });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const full = await models.streamDiveReply({
        system,
        messages,
        onText: (t) => send({ text: t }),
      });
      send({ done: true, text: full });
    } catch (err) {
      send({ error: err.message || "Dive reply failed." });
    }
    res.end();
  });

  app.post("/api/dive/quick", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const prompt = (req.body?.prompt || "").toString();
    if (!system || !prompt) {
      return res.status(400).json({ error: "system and prompt are required." });
    }
    try {
      const answer = await models.quickAnswer({ system, prompt });
      res.json({ answer });
    } catch (err) {
      res.status(502).json({ error: err.message || "Quick meaning failed." });
    }
  });

  return app;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test server/app.test.js`
Expected: all 7 tests PASS.

- [x] **Step 5: Commit**

```bash
git add server/app.js server/app.test.js
git commit -m "feat: add stateless Express app for Deep Dive API routes"
```

---

### Task 3: Backend entrypoint + dev wiring

**Files:**
- Create: `server/index.js`
- Create: `.env.example`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `vite.config.ts`

**Interfaces:**
- Consumes: `buildApp` from Task 2 (`server/app.js`), `createDiveModels` from Task 1 (`server/claude.js`).
- Produces: `npm run dev` starts both Vite and the API server together; `npm start` runs the API server in production mode (also serving the built `dist/`); `npm test` runs the backend test suite; the Vite dev server proxies `/api/*` to the backend.

- [x] **Step 1: Install dependencies**

```bash
npm install express
npm install -D concurrently
```

- [x] **Step 2: Create the entrypoint**

Create `server/index.js`:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildApp } from "./app.js";
import { createDiveModels } from "./claude.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4300;

const app = buildApp({ models: createDiveModels() });

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "dist")));
}

app.listen(PORT, () => {
  console.log(`Deep Dive API listening on http://localhost:${PORT}`);
});
```

- [x] **Step 3: Add `.env.example`**

Create `.env.example` at the project root:

```
# Requires the `claude` CLI (Claude Code) installed and logged in — Deep Dive
# rides your Claude subscription auth, no ANTHROPIC_API_KEY needed.
#
# Optional overrides:
# PORT=4300
# DIVE_MODEL=claude-sonnet-5
# QUICK_MODEL=claude-haiku-4-5-20251001
# CLAUDE_BIN=claude
```

- [x] **Step 4: Ignore `.env`**

In `.gitignore`, add a new line after the `*.local` line:

```
.env
```

- [x] **Step 5: Update `package.json` scripts**

Edit the `"scripts"` block in `package.json` to:

```json
  "scripts": {
    "dev": "concurrently -n vite,server -c blue,green \"vite\" \"node server/index.js\"",
    "build": "tsc -b && vite build",
    "start": "NODE_ENV=production node server/index.js",
    "server": "node server/index.js",
    "lint": "oxlint",
    "preview": "vite preview",
    "test": "node --test server/*.test.js"
  },
```

- [x] **Step 6: Add the Vite dev proxy**

Edit `vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4300',
    },
  },
})
```

- [x] **Step 7: Verify the backend test suite still passes**

Run: `npm test`
Expected: all 12 tests (5 from `claude.test.js` + 7 from `app.test.js`) PASS.

- [x] **Step 8: Verify the dev wiring boots and proxies correctly**

```bash
npm run dev &
sleep 2
curl -s http://localhost:5173/api/health
kill %1
```

Expected: `{"ok":true}` — proving Vite's dev server is proxying `/api` through to the Express backend on port 4300. (If port 5173 is taken, check the `vite` output line in the concurrently log for the actual port and curl that instead.)

- [x] **Step 9: Commit**

```bash
git add server/index.js .env.example .gitignore package.json package-lock.json vite.config.ts
git commit -m "feat: wire up Deep Dive backend dev/prod scripts and Vite proxy"
```

---

### Task 4: Dive panel types + pure tree helpers

**Files:**
- Modify: `src/types.ts`
- Create: `src/deepdive/types.ts`
- Create: `src/deepdive/tree.ts`

**Interfaces:**
- Produces: `DiveTurn`, `DivePanel`, `Pin`, `ChainEntry` types (consumed by every later frontend task); `panelById`, `ancestorChain`, `paneWindow`, `createRootPanel`, `createNestedPanel`, `appendTurn`, `replacePanel`, `childrenOf` (consumed by Task 5 (store round-trips), Task 12 (`DivePanelPane`'s inline nested-dive markers), Task 13 (`DeepDiveView`), Task 14 (`App.tsx`)).
- `CommentedHighlight` (existing type) gains `divePanelId?: string`.

No test framework exists for the frontend (Global Constraints); this task is verified via `tsc -b` and exercised end-to-end starting at Task 14.

- [x] **Step 1: Add `divePanelId` to `CommentedHighlight`**

In `src/types.ts`, add one field to the existing interface:

```ts
import type { Content, Highlight } from "react-pdf-highlighter-plus";

export interface CommentedHighlight extends Highlight {
  content: Content;
  comment?: string;
  highlightColor?: string;
  highlightStyle?: "highlight" | "underline" | "strikethrough";
  color?: string;
  backgroundColor?: string;
  fontSize?: string;
  fontFamily?: string;
  divePanelId?: string;
}
```

- [x] **Step 2: Create the Deep Dive types**

Create `src/deepdive/types.ts`:

```ts
export interface DiveTurn {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO timestamp
}

export interface DivePanel {
  id: string;
  parentId: string | null; // null = anchored directly to the PDF (root)
  anchorHighlightId: string | null; // set iff parentId is null
  selection: string; // exact phrase dived into
  label: string; // selection, truncated to 60 chars
  contextText: string; // page(+prev page) text (root) or parent turn text (nested)
  turns: DiveTurn[];
  createdAt: string;
}

export interface Pin {
  id: string;
  text: string;
  context: string;
  createdAt: string;
}

export interface ChainEntry {
  id: string | null; // null = the PDF root
  label: string;
}
```

- [x] **Step 3: Create the pure tree helpers**

Create `src/deepdive/tree.ts`:

```ts
import type { ChainEntry, DivePanel, DiveTurn } from "./types";

export function panelById(panels: DivePanel[], id: string): DivePanel | null {
  return panels.find((p) => p.id === id) ?? null;
}

// Walks parentId pointers from focusId up to the implicit PDF root, producing
// an ordered [root, ..., focused] list — the same shape both the breadcrumb
// and the pane window are derived from.
export function ancestorChain(
  panels: DivePanel[],
  focusId: string | null,
  rootLabel: string,
): ChainEntry[] {
  const chain: ChainEntry[] = [];
  let id = focusId;
  while (id != null) {
    const panel = panelById(panels, id);
    if (!panel) break;
    chain.unshift({ id: panel.id, label: panel.label });
    id = panel.parentId;
  }
  chain.unshift({ id: null, label: rootLabel });
  return chain;
}

// The split view always shows at most the last two entries of the chain.
export function paneWindow(chain: ChainEntry[]): ChainEntry[] {
  return chain.slice(-2);
}

const getNextId = () => crypto.randomUUID();

export function createRootPanel(params: {
  anchorHighlightId: string;
  selection: string;
  contextText: string;
}): DivePanel {
  return {
    id: getNextId(),
    parentId: null,
    anchorHighlightId: params.anchorHighlightId,
    selection: params.selection,
    label: params.selection.slice(0, 60),
    contextText: params.contextText,
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function createNestedPanel(params: {
  parentId: string;
  selection: string;
  contextText: string;
}): DivePanel {
  return {
    id: getNextId(),
    parentId: params.parentId,
    anchorHighlightId: null,
    selection: params.selection,
    label: params.selection.slice(0, 60),
    contextText: params.contextText,
    turns: [],
    createdAt: new Date().toISOString(),
  };
}

export function appendTurn(panel: DivePanel, role: DiveTurn["role"], content: string): DivePanel {
  return {
    ...panel,
    turns: [...panel.turns, { role, content, at: new Date().toISOString() }],
  };
}

export function replacePanel(panels: DivePanel[], updated: DivePanel): DivePanel[] {
  return panels.map((p) => (p.id === updated.id ? updated : p));
}

// Direct children of a panel — used to find which of a panel's own dive
// branches to render as inline clickable markers in its turn text (Task 12).
export function childrenOf(panels: DivePanel[], parentId: string): DivePanel[] {
  return panels.filter((p) => p.parentId === parentId);
}
```

- [x] **Step 4: Verify types**

Run: `npx tsc -b`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add src/types.ts src/deepdive/types.ts src/deepdive/tree.ts
git commit -m "feat: add Deep Dive panel/pin types and pure tree helpers"
```

---

### Task 5: Dive panel + pin persistence (`src/deepdive/store.ts`)

**Files:**
- Create: `src/deepdive/store.ts`

**Interfaces:**
- Consumes: `DivePanel`, `Pin` from Task 4 (`src/deepdive/types.ts`).
- Produces: `divesKeyForFile(file): string`, `pinsKeyForFile(file): string`, `loadDivePanels(key): DivePanel[]`, `saveDivePanels(key, panels)`, `loadPins(key): Pin[]`, `savePins(key, pins)`. Consumed by Task 14 (`App.tsx`).

Mirrors the existing `storageKeyForFile`/`loadHighlights`/`saveHighlights` pattern already in `App.tsx`.

- [x] **Step 1: Write the module**

Create `src/deepdive/store.ts`:

```ts
import type { DivePanel, Pin } from "./types";

function keyForFile(prefix: string, file: File): string {
  return `${prefix}:${file.name}:${file.size}:${file.lastModified}`;
}

export function divesKeyForFile(file: File): string {
  return keyForFile("pdf-dives", file);
}

export function pinsKeyForFile(file: File): string {
  return keyForFile("pdf-pins", file);
}

export function loadDivePanels(key: string): DivePanel[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as DivePanel[];
  } catch {
    return [];
  }
}

export function saveDivePanels(key: string, panels: DivePanel[]) {
  localStorage.setItem(key, JSON.stringify(panels));
}

export function loadPins(key: string): Pin[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as Pin[];
  } catch {
    return [];
  }
}

export function savePins(key: string, pins: Pin[]) {
  localStorage.setItem(key, JSON.stringify(pins));
}
```

- [x] **Step 2: Verify types**

Run: `npx tsc -b`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add src/deepdive/store.ts
git commit -m "feat: add localStorage persistence for dive panels and pins"
```

---

### Task 6: PDF context extraction + prompt builders

**Files:**
- Create: `src/deepdive/pdfContext.ts`
- Create: `src/deepdive/prompts.ts`

**Interfaces:**
- Produces: `extractPageContext(pdfDocument, pageNumber): Promise<string>`. Consumed by Task 11 (`PdfPane.tsx`).
- Produces: `buildDiveSystem(fileName, panel, parentPanel): string`, `buildQuickMeaningSystem(fileName): string`, `buildQuickMeaningPrompt(selection, context): string`, `openingMessage(selection): string`. Consumed by Task 14 (`App.tsx`).
- Consumes: `DivePanel` from Task 4.

`react-pdf-highlighter-plus` exports `extractPageTextItems(pdfDocument, {pages, columnDetection?}): Promise<PdfExtractedPage[]>` where each `PdfExtractedPage` has `{pageNumber, width, height, textItems: {text, index, pageNumber, rect, ...}[]}`. `PDFDocumentProxy` is exported from `pdfjs-dist` (already a direct dependency).

- [x] **Step 1: Write `pdfContext.ts`**

Create `src/deepdive/pdfContext.ts`:

```ts
import { extractPageTextItems } from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";

// Root-dive context: the selected phrase's page plus the page before it, so
// short/ambiguous selections still get real surrounding context without
// extracting the whole document. Never throws — a failed extraction just
// means the dive proceeds with the selection alone.
export async function extractPageContext(
  pdfDocument: PDFDocumentProxy,
  pageNumber: number,
): Promise<string> {
  const pages = pageNumber > 1 ? [pageNumber - 1, pageNumber] : [pageNumber];
  try {
    const extracted = await extractPageTextItems(pdfDocument, { pages });
    return extracted
      .slice()
      .sort((a, b) => a.pageNumber - b.pageNumber)
      .map((page) => page.textItems.map((item) => item.text).join(" "))
      .join("\n\n");
  } catch {
    return "";
  }
}
```

- [x] **Step 2: Write `prompts.ts`**

Create `src/deepdive/prompts.ts`:

```ts
import type { DivePanel } from "./types";

export function buildDiveSystem(
  fileName: string,
  panel: DivePanel,
  parentPanel: DivePanel | null,
): string {
  const nested = parentPanel
    ? `\nThis is a deeper dive within: "${parentPanel.selection}".`
    : "";
  return `You are a knowledgeable guide helping a reader understand a PDF titled "${fileName}".
The reader selected this passage to dive deeper into: "${panel.selection}"${nested}

Relevant context:
"""
${panel.contextText}
"""

Explain the selection clearly, scoped to this context. Keep replies focused; the reader can ask follow-up questions in this same panel.`;
}

export function buildQuickMeaningSystem(fileName: string): string {
  return `You are a one-tap glossary for a reader studying a PDF titled "${fileName}". Answer in at most two plain-language sentences. No preamble.`;
}

export function buildQuickMeaningPrompt(selection: string, context: string): string {
  return `Explain: "${selection}"${context ? `\n\nIt appeared in this passage:\n${context.slice(0, 1000)}` : ""}`;
}

export function openingMessage(selection: string): string {
  return `I'd like to dive deeper into: "${selection}"`;
}
```

- [x] **Step 3: Verify types**

Run: `npx tsc -b`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add src/deepdive/pdfContext.ts src/deepdive/prompts.ts
git commit -m "feat: add PDF page-context extraction and dive prompt builders"
```

---

### Task 7: API client (`src/deepdive/api.ts`)

**Files:**
- Create: `src/deepdive/api.ts`

**Interfaces:**
- Produces: `streamDiveReply({system, messages, onText}): Promise<string>`, `quickMeaning({system, prompt}): Promise<string>`. Consumed by Task 14 (`App.tsx`).
- Talks to the two routes from Task 2 (`POST /api/dive/stream`, `POST /api/dive/quick`), proxied by Vite per Task 3.

- [x] **Step 1: Write the module**

Create `src/deepdive/api.ts`:

```ts
export interface DiveMessage {
  role: "user" | "assistant";
  content: string;
}

// Reads the backend's SSE stream (see server/app.js's /api/dive/stream),
// forwarding each text delta to onText and resolving with the final full
// reply text once the "done" frame arrives.
export async function streamDiveReply(params: {
  system: string;
  messages: DiveMessage[];
  onText: (chunk: string) => void;
}): Promise<string> {
  const res = await fetch("/api/dive/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system: params.system, messages: params.messages }),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(data.error);
      if (data.done) {
        full = data.text ?? full;
      } else if (typeof data.text === "string") {
        full += data.text;
        params.onText(data.text);
      }
    }
  }

  return full;
}

export async function quickMeaning(params: { system: string; prompt: string }): Promise<string> {
  const res = await fetch("/api/dive/quick", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.answer;
}
```

- [x] **Step 2: Verify types**

Run: `npx tsc -b`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add src/deepdive/api.ts
git commit -m "feat: add Deep Dive API client"
```

---

### Task 8: Selection capture hook + popover UI

**Files:**
- Create: `src/deepdive/useSelectionCapture.ts`
- Create: `src/deepdive/DiveActionButtons.tsx`
- Create: `src/deepdive/SelectionPopover.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Produces: `useSelectionCapture(containerRef, contextSelector) => { captured: {text, context, position} | null, clear: () => void }`. Consumed by Task 12 (`DivePanelPane.tsx`).
- Produces: `<DiveActionButtons onDiveDeeper={() => void} onQuickMeaning={() => Promise<string>} onPin={() => void} />` — the 3-button row + inline quick-meaning answer, no positioning of its own. Consumed by Task 9 (`ExpandableTip.tsx`, which is already positioned by the PDF library's own tip mechanism) and by `SelectionPopover` below (for contexts with no built-in positioning).
- Produces: `<SelectionPopover selection position onDiveDeeper onQuickMeaning onPin onClose />` — a `position: fixed` floating wrapper around `DiveActionButtons`, for selections made inside plain chat text (no library tip mechanism there). Consumed by Task 12 (`DivePanelPane.tsx`).

- [x] **Step 1: Write the selection-capture hook**

Create `src/deepdive/useSelectionCapture.ts`:

```ts
import { useEffect, useState, type RefObject } from "react";

export interface CapturedSelection {
  text: string;
  context: string;
  position: { x: number; y: number };
}

const MAX_SELECTION_LENGTH = 400;
const MAX_CONTEXT_LENGTH = 1000;

// Mirrors LearningApp's selection-popover trigger: mouseup inside the given
// container, deferred so window.getSelection() reflects the final selection.
// Position is viewport-relative (not scroll-adjusted) since the popover that
// consumes this renders position: fixed.
export function useSelectionCapture(
  containerRef: RefObject<HTMLElement | null>,
  contextSelector: string,
) {
  const [captured, setCaptured] = useState<CapturedSelection | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection ? selection.toString().trim() : "";
        if (!text || text.length > MAX_SELECTION_LENGTH || !selection || selection.rangeCount === 0) {
          return;
        }
        const anchorNode = selection.anchorNode;
        const anchorElement =
          anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
        const context =
          anchorElement?.closest(contextSelector)?.textContent?.slice(0, MAX_CONTEXT_LENGTH) || "";
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        setCaptured({
          text,
          context,
          position: { x: rect.left, y: rect.bottom + 6 },
        });
      }, 0);
    };

    container.addEventListener("mouseup", handleMouseUp);
    return () => container.removeEventListener("mouseup", handleMouseUp);
  }, [containerRef, contextSelector]);

  return { captured, clear: () => setCaptured(null) };
}
```

- [x] **Step 2: Write the presentational action-button row**

Create `src/deepdive/DiveActionButtons.tsx`:

```tsx
import { useState } from "react";

export interface DiveActionButtonsProps {
  onDiveDeeper: () => void;
  onQuickMeaning: () => Promise<string>;
  onPin: () => void;
}

export default function DiveActionButtons({
  onDiveDeeper,
  onQuickMeaning,
  onPin,
}: DiveActionButtonsProps) {
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinned, setPinned] = useState(false);

  const handleQuickMeaning = async () => {
    setLoading(true);
    setAnswer(null);
    try {
      setAnswer(await onQuickMeaning());
    } catch (err) {
      setAnswer(err instanceof Error ? err.message : "Failed to get an answer.");
    } finally {
      setLoading(false);
    }
  };

  const handlePin = () => {
    onPin();
    setPinned(true);
  };

  return (
    <div className="dive-action-buttons">
      <div className="dive-action-row">
        <button type="button" className="tip-button" onClick={onDiveDeeper}>
          Dive deeper
        </button>
        <button type="button" onClick={handleQuickMeaning} disabled={loading}>
          {loading ? "Thinking…" : "Quick meaning"}
        </button>
        <button type="button" onClick={handlePin} disabled={pinned}>
          {pinned ? "Pinned" : "Pin"}
        </button>
      </div>
      {answer ? <p className="dive-action-answer">{answer}</p> : null}
    </div>
  );
}
```

- [x] **Step 3: Write the floating popover wrapper**

Create `src/deepdive/SelectionPopover.tsx`:

```tsx
import DiveActionButtons from "./DiveActionButtons";

export interface SelectionPopoverProps {
  selection: string;
  position: { x: number; y: number };
  onDiveDeeper: () => void;
  onQuickMeaning: () => Promise<string>;
  onPin: () => void;
  onClose: () => void;
}

export default function SelectionPopover({
  selection,
  position,
  onDiveDeeper,
  onQuickMeaning,
  onPin,
  onClose,
}: SelectionPopoverProps) {
  return (
    <div
      className="selection-popover"
      style={{ left: position.x, top: position.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button type="button" className="selection-popover-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <DiveActionButtons onDiveDeeper={onDiveDeeper} onQuickMeaning={onQuickMeaning} onPin={onPin} />
      <p className="selection-popover-selection">"{selection}"</p>
    </div>
  );
}
```

- [x] **Step 4: Add CSS**

Append to `src/App.css`:

```css
.dive-action-buttons {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.dive-action-row {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.dive-action-row button {
  border: 1px solid #d1d5db;
  background: #f9fafb;
  border-radius: 0.5rem;
  padding: 0.35rem 0.6rem;
  font-size: 0.8rem;
}

.dive-action-answer {
  margin: 0;
  font-size: 0.85rem;
  color: #1f2937;
  line-height: 1.4;
}

.selection-popover {
  position: fixed;
  z-index: 40;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 0.65rem;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18);
  padding: 0.6rem;
  min-width: 260px;
  max-width: 320px;
}

.selection-popover-close {
  float: right;
  border: 0;
  background: transparent;
  color: #6b7280;
  font-size: 1rem;
  padding: 0.1rem 0.4rem;
  line-height: 1;
}

.selection-popover-selection {
  margin: 0.4rem 0 0;
  font-size: 0.75rem;
  color: #9ca3af;
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  clear: both;
}
```

- [x] **Step 5: Verify types**

Run: `npx tsc -b`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add src/deepdive/useSelectionCapture.ts src/deepdive/DiveActionButtons.tsx src/deepdive/SelectionPopover.tsx src/App.css
git commit -m "feat: add selection-capture hook and dive action popover UI"
```

---

### Task 9: Wire Dive actions into `ExpandableTip`

**Files:**
- Modify: `src/components/ExpandableTip.tsx`

**Interfaces:**
- Consumes: `DiveActionButtons` from Task 8.
- Produces: `ExpandableTip` now takes 3 new required props — `onDiveDeeper: (highlight: GhostHighlight) => void`, `onQuickMeaning: (selectionText: string, pageNumber: number) => Promise<string>`, `onPin: (selectionText: string, pageNumber: number) => void` — alongside the existing `addHighlight`. Consumed by Task 11 (`PdfPane.tsx`).

The existing "Add highlight" → `CommentForm` flow is unchanged; the three new actions render alongside it in the compact view, reading the live selection directly (no ghost highlight needed since these paths don't show a comment form).

- [x] **Step 1: Rewrite the component**

Replace the full contents of `src/components/ExpandableTip.tsx`:

```tsx
import { useLayoutEffect, useRef, useState } from "react";
import CommentForm from "./CommentForm";
import DiveActionButtons from "../deepdive/DiveActionButtons";
import type { GhostHighlight } from "react-pdf-highlighter-plus";
import { usePdfHighlighterContext } from "react-pdf-highlighter-plus";

interface ExpandableTipProps {
  addHighlight: (highlight: GhostHighlight, comment: string) => void;
  onDiveDeeper: (highlight: GhostHighlight) => void;
  onQuickMeaning: (selectionText: string, pageNumber: number) => Promise<string>;
  onPin: (selectionText: string, pageNumber: number) => void;
}

export default function ExpandableTip({
  addHighlight,
  onDiveDeeper,
  onQuickMeaning,
  onPin,
}: ExpandableTipProps) {
  const [compact, setCompact] = useState(true);
  const selectionRef = useRef<ReturnType<
    ReturnType<typeof usePdfHighlighterContext>["getCurrentSelection"]
  > | null>(null);

  const {
    getCurrentSelection,
    removeGhostHighlight,
    setTip,
    updateTipPosition,
  } = usePdfHighlighterContext();

  useLayoutEffect(() => {
    updateTipPosition?.();
  }, [compact, updateTipPosition]);

  return (
    <div className="expandable-tip">
      {compact ? (
        <>
          <button
            type="button"
            className="tip-button"
            onClick={() => {
              setCompact(false);
              selectionRef.current = getCurrentSelection();
              selectionRef.current?.makeGhostHighlight();
            }}
          >
            Add highlight
          </button>
          <DiveActionButtons
            onDiveDeeper={() => {
              const selection = getCurrentSelection();
              if (!selection) return;
              onDiveDeeper({
                content: selection.content,
                type: selection.type,
                position: selection.position,
              });
              setTip(null);
            }}
            onQuickMeaning={async () => {
              const selection = getCurrentSelection();
              const text = selection?.content.text;
              if (!text) throw new Error("No text selected.");
              return onQuickMeaning(text, selection.position.boundingRect.pageNumber);
            }}
            onPin={() => {
              const selection = getCurrentSelection();
              const text = selection?.content.text;
              if (!text) return;
              onPin(text, selection.position.boundingRect.pageNumber);
            }}
          />
        </>
      ) : (
        <CommentForm
          onSubmit={(input) => {
            const selection = selectionRef.current;
            if (!selection) return;

            addHighlight(
              {
                content: selection.content,
                type: selection.type,
                position: selection.position,
              },
              input,
            );

            removeGhostHighlight();
            setTip(null);
          }}
        />
      )}
    </div>
  );
}
```

- [x] **Step 2: Verify types**

Run: `npx tsc -b`
Expected: errors about missing `onDiveDeeper`/`onQuickMeaning`/`onPin` props at the `<ExpandableTip ...>` call site in `App.tsx` — this is expected until Task 14 rewires `App.tsx`. Confirm the error is *only* at that call site and `ExpandableTip.tsx` itself has no errors.

- [x] **Step 3: Commit**

```bash
git add src/components/ExpandableTip.tsx
git commit -m "feat: add Dive deeper, Quick meaning, and Pin actions to the selection tip"
```

---

### Task 10: Dive badge on highlights + Pins section in the sidebar

**Files:**
- Create: `src/deepdive/DiveBadge.tsx`
- Modify: `src/components/HighlightContainer.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Produces: `<DiveBadge onClick={() => void} />`. Consumed by `HighlightContainer.tsx` and `Sidebar.tsx` in this task.
- `HighlightContainer` gains a required `onOpenDive: (divePanelId: string) => void` prop.
- `Sidebar` gains required `pins: Pin[]`, `onOpenDive: (divePanelId: string) => void`, `onDeletePin: (pinId: string) => void` props. Both new `HighlightContainer`/`Sidebar` prop shapes are consumed by Task 14 (`App.tsx`).

- [x] **Step 1: Write the badge component**

Create `src/deepdive/DiveBadge.tsx`:

```tsx
interface DiveBadgeProps {
  onClick: () => void;
}

export default function DiveBadge({ onClick }: DiveBadgeProps) {
  return (
    <button
      type="button"
      className="dive-badge"
      title="Open this dive"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      Dive ↗
    </button>
  );
}
```

- [x] **Step 2: Wire the badge into `HighlightContainer`**

Replace the full contents of `src/components/HighlightContainer.tsx`:

```tsx
import {
  AreaHighlight,
  FreetextHighlight,
  TextHighlight,
  useHighlightContainerContext,
  usePdfHighlighterContext,
} from "react-pdf-highlighter-plus";
import { useHighlightCommentControls } from "./HighlightPopup";
import DiveBadge from "../deepdive/DiveBadge";
import type { CommentedHighlight } from "../types";

interface HighlightContainerProps {
  editHighlight: (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => void;
  deleteHighlight: (highlightId: string) => void;
  onOpenDive: (divePanelId: string) => void;
}

export default function HighlightContainer({
  editHighlight,
  deleteHighlight,
  onOpenDive,
}: HighlightContainerProps) {
  const {
    highlight,
    viewportToScaled,
    screenshot,
    isScrolledTo,
    highlightBindings,
  } = useHighlightContainerContext<CommentedHighlight>();

  const { toggleEditInProgress } = usePdfHighlighterContext();

  const commentControls = useHighlightCommentControls(
    highlight,
    (edit) => editHighlight(highlight.id, edit),
    highlight.type === "text" ? "TextHighlight" : "AreaHighlight",
  );

  const diveBadge = highlight.divePanelId ? (
    <DiveBadge onClick={() => onOpenDive(highlight.divePanelId!)} />
  ) : null;

  if (highlight.type === "text") {
    return (
      <TextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        onStyleChange={(style) => editHighlight(highlight.id, style)}
        onDelete={() => deleteHighlight(highlight.id)}
        extraButtons={
          <>
            {commentControls.button}
            {diveBadge}
          </>
        }
        extraPanel={commentControls.panel}
      />
    );
  }

  if (highlight.type === "freetext") {
    return (
      <FreetextHighlight
        highlight={highlight}
        isScrolledTo={isScrolledTo}
        onChange={(boundingRect) => {
          editHighlight(highlight.id, {
            position: {
              boundingRect: viewportToScaled(boundingRect),
              rects: [],
            },
          });
          toggleEditInProgress(false);
        }}
        onTextChange={(newText) => {
          editHighlight(highlight.id, {
            content: { text: newText },
          });
        }}
        onStyleChange={(style) => {
          editHighlight(highlight.id, {
            color: style.color,
            backgroundColor: style.backgroundColor,
            fontSize: style.fontSize,
            fontFamily: style.fontFamily,
          });
        }}
        onEditStart={() => toggleEditInProgress(true)}
        onEditEnd={() => toggleEditInProgress(false)}
        onDelete={() => deleteHighlight(highlight.id)}
      />
    );
  }

  return (
    <AreaHighlight
      highlight={highlight}
      isScrolledTo={isScrolledTo}
      onStyleChange={(style) => editHighlight(highlight.id, style)}
      onDelete={() => deleteHighlight(highlight.id)}
      onChange={(boundingRect) => {
        editHighlight(highlight.id, {
          position: {
            boundingRect: viewportToScaled(boundingRect),
            rects: [],
          },
          content: {
            image: screenshot(boundingRect),
          },
        });
        toggleEditInProgress(false);
      }}
      bounds={highlightBindings.textLayer}
      onEditStart={() => toggleEditInProgress(true)}
      extraButtons={
        <>
          {commentControls.button}
          {diveBadge}
        </>
      }
      extraPanel={commentControls.panel}
    />
  );
}
```

- [x] **Step 3: Add the Pins section + dive badges to `Sidebar`**

Replace the full contents of `src/components/Sidebar.tsx`:

```tsx
import type { CommentedHighlight } from "../types";
import type { Pin } from "../deepdive/types";
import DiveBadge from "../deepdive/DiveBadge";

interface SidebarProps {
  highlights: CommentedHighlight[];
  pins: Pin[];
  fileName: string;
  scrolledToHighlightId: string | null;
  onJumpToHighlight: (highlight: CommentedHighlight) => void;
  onDeleteHighlight: (highlight: CommentedHighlight) => void;
  onClearHighlights: () => void;
  onOpenDive: (divePanelId: string) => void;
  onDeletePin: (pinId: string) => void;
  onUploadNew: () => void;
}

function highlightLabel(highlight: CommentedHighlight): string {
  if (highlight.content?.text) return highlight.content.text;
  if (highlight.type === "freetext") return "Sticky note";
  if (highlight.type === "area") return "Area highlight";
  return "Highlight";
}

export default function Sidebar({
  highlights,
  pins,
  fileName,
  scrolledToHighlightId,
  onJumpToHighlight,
  onDeleteHighlight,
  onClearHighlights,
  onOpenDive,
  onDeletePin,
  onUploadNew,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <h2>Annotations</h2>
        <p className="sidebar-file">{fileName}</p>
        <p className="sidebar-count">
          {highlights.length} annotation{highlights.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="sidebar-list">
        {highlights.length === 0 ? (
          <div className="sidebar-empty">
            <p>No highlights yet</p>
            <p className="sidebar-hint">
              Select text to highlight, hold Alt and drag for area highlights,
              or use Note mode for sticky notes.
            </p>
          </div>
        ) : (
          highlights.map((highlight) => (
            <article
              key={highlight.id}
              className={`sidebar-item${
                scrolledToHighlightId === highlight.id ? " is-active" : ""
              }`}
            >
              <button
                type="button"
                className="sidebar-item-main"
                onClick={() => onJumpToHighlight(highlight)}
              >
                <span className="sidebar-item-type-row">
                  <span className="sidebar-item-type">{highlight.type}</span>
                  {highlight.divePanelId ? (
                    <DiveBadge onClick={() => onOpenDive(highlight.divePanelId!)} />
                  ) : null}
                </span>
                <span className="sidebar-item-page">
                  Page {highlight.position.boundingRect.pageNumber}
                </span>
                <span className="sidebar-item-text">
                  {highlightLabel(highlight)}
                </span>
                {highlight.comment ? (
                  <span className="sidebar-item-comment">{highlight.comment}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="sidebar-item-delete"
                title="Delete annotation"
                onClick={() => onDeleteHighlight(highlight)}
              >
                Delete
              </button>
            </article>
          ))
        )}
      </div>

      <div className="sidebar-pins">
        <h3>Pins</h3>
        {pins.length === 0 ? (
          <p className="sidebar-empty-pins">No pins yet</p>
        ) : (
          <ul className="sidebar-pins-list">
            {pins.map((pin) => (
              <li key={pin.id} className="sidebar-pin">
                <span>{pin.text}</span>
                <button
                  type="button"
                  className="sidebar-pin-delete"
                  title="Delete pin"
                  onClick={() => onDeletePin(pin.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="sidebar-footer">
        <button type="button" onClick={onUploadNew}>
          Upload new PDF
        </button>
        {highlights.length > 0 ? (
          <button type="button" className="danger" onClick={onClearHighlights}>
            Clear all
          </button>
        ) : null}
      </footer>
    </aside>
  );
}
```

- [x] **Step 4: Add CSS**

Append to `src/App.css`:

```css
.dive-badge {
  border: 1px solid #2563eb;
  background: #eff6ff;
  color: #2563eb;
  border-radius: 999px;
  padding: 0.15rem 0.55rem;
  font-size: 0.7rem;
  font-weight: 600;
  cursor: pointer;
}

.sidebar-item-type-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}

.sidebar-pins {
  border-top: 1px solid #e5e7eb;
  padding: 0.75rem 1rem;
}

.sidebar-pins h3 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
}

.sidebar-empty-pins {
  margin: 0;
  color: #9ca3af;
  font-size: 0.85rem;
}

.sidebar-pins-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.sidebar-pin {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.85rem;
  background: #fafafa;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  padding: 0.4rem 0.6rem;
}

.sidebar-pin-delete {
  border: 0;
  background: transparent;
  color: #b91c1c;
  font-size: 0.75rem;
  flex-shrink: 0;
}
```

- [x] **Step 5: Verify types**

Run: `npx tsc -b`
Expected: errors only at the `<HighlightContainer .../>` and `<Sidebar .../>` call sites in `App.tsx` (missing new required props) — expected until Task 14. Confirm no errors inside `HighlightContainer.tsx`, `Sidebar.tsx`, or `DiveBadge.tsx` themselves.

- [x] **Step 6: Commit**

```bash
git add src/deepdive/DiveBadge.tsx src/components/HighlightContainer.tsx src/components/Sidebar.tsx src/App.css
git commit -m "feat: add dive badge on highlights and a Pins section to the sidebar"
```

---

### Task 11: Extract the PDF viewer into a reusable `PdfPane`

**Files:**
- Create: `src/deepdive/PdfPane.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `ExpandableTip` (Task 9), `HighlightContainer` (Task 10), `extractPageContext` (Task 6), `CommentedHighlight` (Task 4).
- Produces: `<PdfPane {...props} />` — the `PdfLoader`/`PdfHighlighter` viewer block, now standalone and reusable both as the normal full-width view and as a pane inside `DeepDiveView` (Task 13). Exports `PdfPaneProps`. Consumed by Task 13 and Task 14.

This task only *moves* code (from `App.tsx`'s current `<main className="viewer">` block) and adds the context-extraction wiring for the three new `ExpandableTip` callbacks — it does not yet change `App.tsx` itself (that's Task 14). Expect `tsc -b` to still show errors in `App.tsx` after this step; that's addressed in Task 14.

- [x] **Step 1: Write `PdfPane.tsx`**

Create `src/deepdive/PdfPane.tsx`:

```tsx
import { useRef } from "react";
import {
  PdfHighlighter,
  PdfLoader,
  type GhostHighlight,
  type PdfHighlighterUtils,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
import type { PDFDocumentProxy } from "pdfjs-dist";
import ExpandableTip from "../components/ExpandableTip";
import HighlightContainer from "../components/HighlightContainer";
import type { CommentedHighlight } from "../types";
import pdfWorkerUrl from "../pdfWorker";
import { extractPageContext } from "./pdfContext";

export type PdfSource = string | Uint8Array;

export interface PdfPaneProps {
  source: PdfSource;
  highlights: CommentedHighlight[];
  areaMode: boolean;
  freetextMode: boolean;
  onFreetextClick: (position: ScaledPosition) => void;
  addHighlight: (highlight: GhostHighlight, comment: string) => void;
  editHighlight: (id: string, edit: Partial<CommentedHighlight>) => void;
  deleteHighlight: (id: string) => void;
  utilsRef: (utils: PdfHighlighterUtils) => void;
  onOpenDive: (divePanelId: string) => void;
  onDiveDeeper: (request: { highlight: GhostHighlight; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
}

export default function PdfPane({
  source,
  highlights,
  areaMode,
  freetextMode,
  onFreetextClick,
  addHighlight,
  editHighlight,
  deleteHighlight,
  utilsRef,
  onOpenDive,
  onDiveDeeper,
  onQuickMeaning,
  onPin,
}: PdfPaneProps) {
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);

  return (
    <div className="pdf-pane-viewer">
      <PdfLoader
        document={source}
        workerSrc={pdfWorkerUrl}
        beforeLoad={() => <div className="loading">Loading PDF…</div>}
      >
        {(pdfDocument) => {
          pdfDocumentRef.current = pdfDocument;
          return (
            <PdfHighlighter
              pdfDocument={pdfDocument}
              highlights={highlights}
              enableAreaSelection={(event) => event.altKey || areaMode}
              areaSelectionMode={areaMode}
              enableFreetextCreation={() => freetextMode}
              onFreetextClick={onFreetextClick}
              selectionTip={
                <ExpandableTip
                  addHighlight={addHighlight}
                  onDiveDeeper={async (highlight) => {
                    const contextText = await extractPageContext(
                      pdfDocumentRef.current!,
                      highlight.position.boundingRect.pageNumber,
                    );
                    onDiveDeeper({ highlight, contextText });
                  }}
                  onQuickMeaning={async (selection, pageNumber) => {
                    const contextText = await extractPageContext(pdfDocumentRef.current!, pageNumber);
                    return onQuickMeaning(selection, contextText);
                  }}
                  onPin={async (selection, pageNumber) => {
                    const contextText = await extractPageContext(pdfDocumentRef.current!, pageNumber);
                    onPin(selection, contextText);
                  }}
                />
              }
              utilsRef={(utils) => utilsRef(utils)}
              style={{ height: "100%" }}
            >
              <HighlightContainer
                editHighlight={editHighlight}
                deleteHighlight={deleteHighlight}
                onOpenDive={onOpenDive}
              />
            </PdfHighlighter>
          );
        }}
      </PdfLoader>
    </div>
  );
}
```

- [x] **Step 2: Move the viewer background styling to `.pdf-pane-viewer`**

In `src/App.css`, the existing `.viewer` rule currently carries both layout and the PDF-canvas background:

```css
.viewer {
  min-height: 0;
  background: #525659;
}
```

Replace it with a layout-only `.viewer` (unchanged responsibility — it's still the grid cell in `App.tsx`'s normal-mode layout) plus a new `.pdf-pane-viewer` rule that `PdfPane` owns and that works in *both* the normal `<main className="viewer">` wrapper and the upcoming `.deep-dive-pane` wrapper (Task 13):

```css
.viewer {
  min-height: 0;
}

.pdf-pane-viewer {
  height: 100%;
  min-height: 0;
  background: #525659;
}
```

- [x] **Step 3: Verify types**

Run: `npx tsc -b`
Expected: no errors inside `src/deepdive/PdfPane.tsx` itself. `App.tsx` will still show errors (it hasn't been updated yet — that's Task 14); confirm the errors are confined to `App.tsx`.

- [x] **Step 4: Commit**

```bash
git add src/deepdive/PdfPane.tsx src/App.css
git commit -m "feat: extract PdfPane as a reusable PDF viewer component"
```

---

### Task 12: Dive chat panel (`DivePanelPane`)

**Files:**
- Create: `src/deepdive/DivePanelPane.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `DivePanel` (Task 4), `childrenOf` (Task 4), `useSelectionCapture` + `SelectionPopover` (Task 8).
- Produces: `<DivePanelPane panel allPanels onOpenDive onSendMessage onNestedDive onQuickMeaning onPin />` where `onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>`, `onNestedDive: (request: {parentId: string; selection: string; contextText: string}) => void`, `onOpenDive: (panelId: string) => void`. Consumed by Task 13 (`DeepDiveView.tsx`).

Renders the panel's turn history, a live-streaming assistant bubble while a reply is in flight, a composer for follow-ups, and reuses `SelectionPopover` for nested dives/quick meaning/pins triggered by selecting text within the panel's own turns (context = the specific turn's full text, matching spec §6's "parent's full reply text"). Per spec §7.4, any substring of a turn that matches one of the panel's own child dives' `selection` is rendered as a clickable marker that calls `onOpenDive` — this is how a branch already dived into gets re-opened without retracing the breadcrumb.

- [x] **Step 1: Write the component**

Create `src/deepdive/DivePanelPane.tsx`:

```tsx
import { useRef, useState, type ReactNode } from "react";
import type { DivePanel } from "./types";
import { childrenOf } from "./tree";
import { useSelectionCapture } from "./useSelectionCapture";
import SelectionPopover from "./SelectionPopover";

export interface DivePanelPaneProps {
  panel: DivePanel;
  allPanels: DivePanel[];
  onOpenDive: (panelId: string) => void;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
}

// Wraps any substring of `content` matching one of `children`'s `selection`
// in a clickable marker. Matches are found independently per child, sorted
// by position, and overlapping matches are dropped (first match wins) —
// approximate on purpose: this is a self-use app, not a rich-text editor.
function renderTurnContent(
  content: string,
  children: DivePanel[],
  onOpenDive: (panelId: string) => void,
): ReactNode {
  if (children.length === 0) return content;

  const matches: { start: number; end: number; panel: DivePanel }[] = [];
  for (const child of children) {
    if (!child.selection) continue;
    const start = content.indexOf(child.selection);
    if (start !== -1) {
      matches.push({ start, end: start + child.selection.length, panel: child });
    }
  }
  if (matches.length === 0) return content;

  matches.sort((a, b) => a.start - b.start);
  const nonOverlapping: typeof matches = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    nonOverlapping.push(match);
    cursor = match.end;
  }

  const nodes: ReactNode[] = [];
  let pos = 0;
  nonOverlapping.forEach((match, index) => {
    if (match.start > pos) nodes.push(content.slice(pos, match.start));
    nodes.push(
      <button
        type="button"
        key={`${match.panel.id}-${index}`}
        className="dive-turn-marker"
        onClick={(event) => {
          event.stopPropagation();
          onOpenDive(match.panel.id);
        }}
      >
        {content.slice(match.start, match.end)}
      </button>,
    );
    pos = match.end;
  });
  if (pos < content.length) nodes.push(content.slice(pos));
  return nodes;
}

export default function DivePanelPane({
  panel,
  allPanels,
  onOpenDive,
  onSendMessage,
  onNestedDive,
  onQuickMeaning,
  onPin,
}: DivePanelPaneProps) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [streamingReply, setStreamingReply] = useState("");
  const dialogueRef = useRef<HTMLDivElement>(null);
  const { captured, clear } = useSelectionCapture(dialogueRef, ".dive-turn");
  const children = childrenOf(allPanels, panel.id);

  const send = async (content: string) => {
    if (!content.trim() || pending) return;
    setPending(true);
    setStreamingReply("");
    await onSendMessage(panel.id, content, (chunk) => setStreamingReply((prev) => prev + chunk));
    setStreamingReply("");
    setPending(false);
  };

  return (
    <div className="dive-panel-pane">
      <header className="dive-panel-header">{panel.label}</header>
      <div className="dive-panel-dialogue" ref={dialogueRef}>
        {panel.turns.map((turn, index) => (
          <div key={index} className={`dive-turn dive-turn-${turn.role}`}>
            {renderTurnContent(turn.content, children, onOpenDive)}
          </div>
        ))}
        {pending ? (
          <div className="dive-turn dive-turn-assistant dive-turn-streaming">
            {streamingReply || "…"}
          </div>
        ) : null}
      </div>
      {captured ? (
        <SelectionPopover
          selection={captured.text}
          position={captured.position}
          onDiveDeeper={() => {
            onNestedDive({ parentId: panel.id, selection: captured.text, contextText: captured.context });
            clear();
          }}
          onQuickMeaning={() => onQuickMeaning(captured.text, captured.context)}
          onPin={() => {
            onPin(captured.text, captured.context);
            clear();
          }}
          onClose={clear}
        />
      ) : null}
      <form
        className="dive-panel-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const content = draft.trim();
          if (!content) return;
          setDraft("");
          void send(content);
        }}
      >
        <textarea
          value={draft}
          placeholder="Ask a follow-up…"
          rows={2}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
    </div>
  );
}
```

- [x] **Step 2: Add CSS**

Append to `src/App.css`:

```css
.dive-panel-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #ffffff;
}

.dive-panel-header {
  padding: 0.75rem 1rem;
  font-weight: 600;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dive-panel-dialogue {
  flex: 1;
  overflow: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  position: relative;
}

.dive-turn {
  max-width: 85%;
  padding: 0.6rem 0.85rem;
  border-radius: 0.75rem;
  line-height: 1.5;
  white-space: pre-wrap;
}

.dive-turn-user {
  align-self: flex-end;
  background: #2563eb;
  color: #ffffff;
}

.dive-turn-assistant {
  align-self: flex-start;
  background: #f3f4f6;
  color: #111827;
}

.dive-turn-streaming {
  opacity: 0.75;
}

.dive-turn-marker {
  border: 0;
  background: transparent;
  padding: 0;
  font: inherit;
  color: inherit;
  text-decoration: underline;
  text-decoration-style: dotted;
  cursor: pointer;
}

.dive-panel-composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid #e5e7eb;
}

.dive-panel-composer textarea {
  flex: 1;
  resize: vertical;
  border: 1px solid #d1d5db;
  border-radius: 0.5rem;
  padding: 0.5rem;
  font: inherit;
}

.dive-panel-composer button {
  border: 0;
  background: #2563eb;
  color: #ffffff;
  border-radius: 0.5rem;
  padding: 0 1rem;
}
```

- [x] **Step 3: Verify types**

Run: `npx tsc -b`
Expected: no errors inside `src/deepdive/DivePanelPane.tsx` itself (App.tsx errors persist until Task 14).

- [x] **Step 4: Commit**

```bash
git add src/deepdive/DivePanelPane.tsx src/App.css
git commit -m "feat: add DivePanelPane dive chat component"
```

---

### Task 13: Split view (`DeepDiveView`) — breadcrumb + sliding 2-pane window

**Files:**
- Create: `src/deepdive/DeepDiveView.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `ancestorChain`, `paneWindow` (Task 4), `PdfPane`/`PdfPaneProps` (Task 11), `DivePanelPane` (Task 12).
- Produces: `<DeepDiveView panels focusId rootLabel onFocusChange pdfPaneProps onSendMessage onNestedDive onQuickMeaning onPin />`. Consumed by Task 14 (`App.tsx`).

Implements spec §7.2–§7.3: a clickable breadcrumb built from `ancestorChain`, and a pane row that always renders `paneWindow(chain)` — the focused panel plus its immediate predecessor (root/PDF if the chain is only 2 deep). Clicking the root crumb calls `onFocusChange(null)`, which is how `App.tsx` (Task 14) exits Deep Dive mode entirely.

- [x] **Step 1: Write the component**

Create `src/deepdive/DeepDiveView.tsx`:

```tsx
import type { DivePanel } from "./types";
import { ancestorChain, paneWindow, panelById } from "./tree";
import DivePanelPane from "./DivePanelPane";
import PdfPane, { type PdfPaneProps } from "./PdfPane";

export interface DeepDiveViewProps {
  panels: DivePanel[];
  focusId: string;
  rootLabel: string;
  onFocusChange: (id: string | null) => void;
  pdfPaneProps: PdfPaneProps;
  onSendMessage: (panelId: string, content: string, onChunk?: (chunk: string) => void) => Promise<void>;
  onNestedDive: (request: { parentId: string; selection: string; contextText: string }) => void;
  onQuickMeaning: (selection: string, contextText: string) => Promise<string>;
  onPin: (selection: string, contextText: string) => void;
}

export default function DeepDiveView({
  panels,
  focusId,
  rootLabel,
  onFocusChange,
  pdfPaneProps,
  onSendMessage,
  onNestedDive,
  onQuickMeaning,
  onPin,
}: DeepDiveViewProps) {
  const chain = ancestorChain(panels, focusId, rootLabel);
  const paneEntries = paneWindow(chain);

  return (
    <div className="deep-dive-view">
      <nav className="deep-dive-breadcrumb">
        {chain.map((entry, index) => (
          <span key={entry.id ?? "root"} className="deep-dive-crumb-group">
            <button
              type="button"
              className={`deep-dive-crumb${index === chain.length - 1 ? " current" : ""}`}
              onClick={() => onFocusChange(entry.id)}
            >
              {entry.label}
            </button>
            {index < chain.length - 1 ? <span className="deep-dive-crumb-sep">›</span> : null}
          </span>
        ))}
      </nav>
      <div className="deep-dive-panes">
        {paneEntries.map((entry) => (
          <div className="deep-dive-pane" key={entry.id ?? "root"}>
            {entry.id === null ? (
              <PdfPane {...pdfPaneProps} />
            ) : (
              <DivePanelPane
                panel={panelById(panels, entry.id)!}
                allPanels={panels}
                onOpenDive={onFocusChange}
                onSendMessage={onSendMessage}
                onNestedDive={onNestedDive}
                onQuickMeaning={onQuickMeaning}
                onPin={onPin}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [x] **Step 2: Add CSS**

Append to `src/App.css`:

```css
.deep-dive-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.deep-dive-breadcrumb {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  padding: 0.6rem 1rem;
  background: #f3f4f6;
  border-bottom: 1px solid #e5e7eb;
  font-size: 0.85rem;
}

.deep-dive-crumb-group {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.deep-dive-crumb {
  border: 0;
  background: transparent;
  color: #2563eb;
  padding: 0.15rem 0.3rem;
  font-size: 0.85rem;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.deep-dive-crumb.current {
  color: #111827;
  font-weight: 600;
}

.deep-dive-crumb-sep {
  color: #9ca3af;
}

.deep-dive-panes {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.deep-dive-pane {
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid #e5e7eb;
  display: flex;
  flex-direction: column;
}

.deep-dive-pane:last-child {
  border-right: 0;
}
```

- [x] **Step 3: Verify types**

Run: `npx tsc -b`
Expected: no errors inside `src/deepdive/DeepDiveView.tsx` itself (App.tsx errors persist until Task 14).

- [x] **Step 4: Commit**

```bash
git add src/deepdive/DeepDiveView.tsx src/App.css
git commit -m "feat: add DeepDiveView breadcrumb and sliding 2-pane split view"
```

---

### Task 14: Wire Deep Dive into `App.tsx`

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes everything from Tasks 4–13: `DivePanel`/`Pin` types, `tree.ts` helpers, `store.ts` persistence, `prompts.ts`, `api.ts`, `PdfPane`, `DeepDiveView`, and the updated `Sidebar`/`HighlightContainer` (via `PdfPane`) prop shapes.
- This is the task where every `tsc -b` error accumulated since Task 9 gets resolved — it's the integration point tying the whole feature together.

This closes the loop from spec §7.1 (`diveFocusId` state controls which layout renders), §7.3 (diving from either visible pane creates a new panel and slides the window), and §9 (stream/CLI failures render as an inline `⚠️` turn rather than crashing).

- [x] **Step 1: Rewrite `App.tsx`**

Replace the full contents of `src/App.tsx`:

```tsx
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  exportPdf,
  type GhostHighlight,
  type PdfHighlighterUtils,
  type ScaledPosition,
} from "react-pdf-highlighter-plus";
import "react-pdf-highlighter-plus/style/style.css";
import Sidebar from "./components/Sidebar";
import type { CommentedHighlight } from "./types";
import "./App.css";
import PdfPane from "./deepdive/PdfPane";
import DeepDiveView from "./deepdive/DeepDiveView";
import type { DivePanel, Pin } from "./deepdive/types";
import {
  appendTurn,
  createNestedPanel,
  createRootPanel,
  panelById,
  replacePanel,
} from "./deepdive/tree";
import {
  divesKeyForFile,
  loadDivePanels,
  loadPins,
  pinsKeyForFile,
  saveDivePanels,
  savePins,
} from "./deepdive/store";
import {
  buildDiveSystem,
  buildQuickMeaningPrompt,
  buildQuickMeaningSystem,
  openingMessage,
} from "./deepdive/prompts";
import { quickMeaning, streamDiveReply } from "./deepdive/api";

type PdfSource = string | Uint8Array;

interface LoadedPdf {
  source: PdfSource;
  fileName: string;
  storageKey: string;
  divesKey: string;
  pinsKey: string;
}

const getNextId = () => crypto.randomUUID();

function storageKeyForFile(file: File): string {
  return `pdf-highlights:${file.name}:${file.size}:${file.lastModified}`;
}

function loadHighlights(key: string): CommentedHighlight[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    return JSON.parse(raw) as CommentedHighlight[];
  } catch {
    return [];
  }
}

function saveHighlights(key: string, highlights: CommentedHighlight[]) {
  localStorage.setItem(key, JSON.stringify(highlights));
}

function UploadScreen({ onFileSelected }: { onFileSelected: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="upload-screen">
      <div className="upload-card">
        <h1>PDF Highlighter</h1>
        <p>
          Upload a PDF to view it, highlight text, add comments, and place sticky
          notes.
        </p>
        <button type="button" onClick={() => inputRef.current?.click()}>
          Choose PDF file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) onFileSelected(file);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}

export default function App() {
  const [loadedPdf, setLoadedPdf] = useState<LoadedPdf | null>(null);
  const [highlights, setHighlights] = useState<CommentedHighlight[]>([]);
  const [panels, setPanels] = useState<DivePanel[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [diveFocusId, setDiveFocusId] = useState<string | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [freetextMode, setFreetextMode] = useState(false);
  const [scrolledToHighlightId, setScrolledToHighlightId] = useState<string | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);

  const highlighterUtilsRef = useRef<PdfHighlighterUtils | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const panelsRef = useRef<DivePanel[]>([]);

  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  useEffect(() => {
    if (!loadedPdf) return;
    saveHighlights(loadedPdf.storageKey, highlights);
  }, [highlights, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    saveDivePanels(loadedPdf.divesKey, panels);
  }, [panels, loadedPdf]);

  useEffect(() => {
    if (!loadedPdf) return;
    savePins(loadedPdf.pinsKey, pins);
  }, [pins, loadedPdf]);

  const loadPdfFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const arrayBuffer = event.target?.result;
      if (!(arrayBuffer instanceof ArrayBuffer)) return;

      const storageKey = storageKeyForFile(file);
      const divesKey = divesKeyForFile(file);
      const pinsKey = pinsKeyForFile(file);
      setLoadedPdf({
        source: new Uint8Array(arrayBuffer),
        fileName: file.name,
        storageKey,
        divesKey,
        pinsKey,
      });
      setHighlights(loadHighlights(storageKey));
      setPanels(loadDivePanels(divesKey));
      setPins(loadPins(pinsKey));
      setAreaMode(false);
      setFreetextMode(false);
      setDiveFocusId(null);
    };
    reader.onerror = () => {
      alert("Failed to read the PDF file.");
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const resetViewer = () => {
    setLoadedPdf(null);
    setHighlights([]);
    setPanels([]);
    setPins([]);
    setDiveFocusId(null);
    setAreaMode(false);
    setFreetextMode(false);
    setScrolledToHighlightId(null);
  };

  const addHighlight = (highlight: GhostHighlight, comment: string) => {
    const next: CommentedHighlight = {
      ...highlight,
      id: getNextId(),
      comment,
    };
    setHighlights((previous) => [next, ...previous]);
    if (areaMode) setAreaMode(false);
  };

  const editHighlight = (
    idToUpdate: string,
    edit: Partial<CommentedHighlight>,
  ) => {
    setHighlights((previous) =>
      previous.map((highlight) =>
        highlight.id === idToUpdate ? { ...highlight, ...edit } : highlight,
      ),
    );
  };

  const deleteHighlight = (highlightId: string) => {
    setHighlights((previous) =>
      previous.filter((highlight) => highlight.id !== highlightId),
    );
  };

  const handleFreetextClick = (position: ScaledPosition) => {
    const next: CommentedHighlight = {
      id: getNextId(),
      type: "freetext",
      position,
      content: { text: "New note" },
    };
    setHighlights((previous) => [next, ...previous]);
    setFreetextMode(false);
  };

  const handleExport = async () => {
    if (!loadedPdf) return;
    setExporting(true);
    try {
      const pdfBytes = await exportPdf(loadedPdf.source, highlights);
      const blob = new Blob([pdfBytes as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = loadedPdf.fileName.replace(/\.pdf$/i, "") + "-annotated.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
      alert("Failed to export PDF. See console for details.");
    } finally {
      setExporting(false);
    }
  };

  const jumpToHighlight = (highlight: CommentedHighlight) => {
    setScrolledToHighlightId(highlight.id);
    highlighterUtilsRef.current?.scrollToHighlight(highlight);
  };

  // Appends the user turn, builds the system prompt from the panel's own
  // context (+ its parent's selection, one sentence, per spec §6), streams
  // the reply, and appends the assistant turn once done. A failure appends
  // an inline "⚠️" turn instead of throwing, so the composer never crashes
  // (spec §9).
  const sendDiveMessage = useCallback(
    async (panelId: string, content: string, onChunk?: (chunk: string) => void) => {
      if (!loadedPdf) return;
      const panel = panelById(panelsRef.current, panelId);
      if (!panel) return;
      const parentPanel = panel.parentId ? panelById(panelsRef.current, panel.parentId) : null;

      const withUserTurn = appendTurn(panel, "user", content);
      setPanels((prev) => replacePanel(prev, withUserTurn));

      const system = buildDiveSystem(loadedPdf.fileName, withUserTurn, parentPanel);
      const messages = withUserTurn.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      }));

      try {
        const full = await streamDiveReply({ system, messages, onText: (chunk) => onChunk?.(chunk) });
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          return replacePanel(prev, appendTurn(latest, "assistant", full));
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Dive reply failed.";
        setPanels((prev) => {
          const latest = panelById(prev, panelId) ?? withUserTurn;
          return replacePanel(prev, appendTurn(latest, "assistant", `⚠️ ${message}`));
        });
      }
    },
    [loadedPdf],
  );

  const createAndOpenDive = useCallback(
    (panel: DivePanel) => {
      setPanels((prev) => [...prev, panel]);
      setDiveFocusId(panel.id);
      void sendDiveMessage(panel.id, openingMessage(panel.selection));
    },
    [sendDiveMessage],
  );

  const handleDiveDeeper = useCallback(
    ({ highlight, contextText }: { highlight: GhostHighlight; contextText: string }) => {
      const text = highlight.content.text;
      if (!text) return;
      const highlightId = getNextId();
      const panel = createRootPanel({
        anchorHighlightId: highlightId,
        selection: text,
        contextText,
      });
      const next: CommentedHighlight = {
        ...highlight,
        id: highlightId,
        comment: "",
        divePanelId: panel.id,
      };
      setHighlights((previous) => [next, ...previous]);
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleNestedDive = useCallback(
    ({ parentId, selection, contextText }: { parentId: string; selection: string; contextText: string }) => {
      const panel = createNestedPanel({ parentId, selection, contextText });
      createAndOpenDive(panel);
    },
    [createAndOpenDive],
  );

  const handleQuickMeaning = useCallback(
    async (selection: string, contextText: string) => {
      if (!loadedPdf) return "";
      return quickMeaning({
        system: buildQuickMeaningSystem(loadedPdf.fileName),
        prompt: buildQuickMeaningPrompt(selection, contextText),
      });
    },
    [loadedPdf],
  );

  const handlePin = useCallback((text: string, context: string) => {
    setPins((previous) => [
      { id: getNextId(), text, context, createdAt: new Date().toISOString() },
      ...previous,
    ]);
  }, []);

  const handleDeletePin = (pinId: string) => {
    setPins((previous) => previous.filter((pin) => pin.id !== pinId));
  };

  const handleOpenDive = (divePanelId: string) => {
    setDiveFocusId(divePanelId);
  };

  if (!loadedPdf) {
    return <UploadScreen onFileSelected={loadPdfFile} />;
  }

  const pdfPaneProps = {
    source: loadedPdf.source,
    highlights,
    areaMode,
    freetextMode,
    onFreetextClick: handleFreetextClick,
    addHighlight,
    editHighlight,
    deleteHighlight,
    utilsRef: (utils: PdfHighlighterUtils) => {
      highlighterUtilsRef.current = utils;
    },
    onOpenDive: handleOpenDive,
    onDiveDeeper: handleDiveDeeper,
    onQuickMeaning: handleQuickMeaning,
    onPin: handlePin,
  };

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div className="toolbar-group">
          <strong className="toolbar-title">{loadedPdf.fileName}</strong>
        </div>
        <div className="toolbar-group toolbar-actions">
          <button
            type="button"
            className={areaMode ? "active" : ""}
            onClick={() => {
              setAreaMode((value) => !value);
              setFreetextMode(false);
            }}
          >
            Area highlight
          </button>
          <button
            type="button"
            className={freetextMode ? "active" : ""}
            onClick={() => {
              setFreetextMode((value) => !value);
              setAreaMode(false);
            }}
          >
            Sticky note
          </button>
          <button type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? "Exporting…" : "Export PDF"}
          </button>
          <button type="button" onClick={() => uploadInputRef.current?.click()}>
            Change PDF
          </button>
        </div>
        <input
          ref={uploadInputRef}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            if (file) loadPdfFile(file);
            event.target.value = "";
          }}
        />
      </header>

      {diveFocusId ? (
        <DeepDiveView
          panels={panels}
          focusId={diveFocusId}
          rootLabel={loadedPdf.fileName}
          onFocusChange={setDiveFocusId}
          pdfPaneProps={pdfPaneProps}
          onSendMessage={sendDiveMessage}
          onNestedDive={handleNestedDive}
          onQuickMeaning={handleQuickMeaning}
          onPin={handlePin}
        />
      ) : (
        <div className="workspace">
          <Sidebar
            highlights={highlights}
            pins={pins}
            fileName={loadedPdf.fileName}
            scrolledToHighlightId={scrolledToHighlightId}
            onJumpToHighlight={jumpToHighlight}
            onDeleteHighlight={(highlight) => deleteHighlight(highlight.id)}
            onClearHighlights={() => setHighlights([])}
            onOpenDive={handleOpenDive}
            onDeletePin={handleDeletePin}
            onUploadNew={resetViewer}
          />

          <main className="viewer">
            <PdfPane {...pdfPaneProps} />
          </main>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 2: Verify types and build**

```bash
npx tsc -b
npx vite build
```

Expected: both clean, zero errors. This is the first point in the plan where the whole app type-checks end-to-end — if errors remain, they'll be prop-shape mismatches between `App.tsx` and one of Tasks 9–13; fix by matching the exact interface names/types recorded in each task's **Interfaces** block.

- [x] **Step 3: Verify lint**

Run: `npx oxlint`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire Deep Dive mode into App.tsx"
```

---

### Task 15: End-to-end verification

**Files:** none (verification only).

**Interfaces:** none — this task exercises the fully wired app from Task 14 against spec §10's test plan.

Requires the local `claude` CLI installed and logged in (Global Constraints) — this is an environment dependency outside the plan's control, same caveat LearningApp's own README carries. If it's not available, run Steps 1–2 (which don't need it) and report the CLI dependency as the reason Steps 3+ couldn't run live.

- [x] **Step 1: Full backend suite + frontend build**

```bash
npm test
npx tsc -b
npx vite build
npx oxlint
```

Expected: all green.

- [x] **Step 2: Boot the app**

```bash
npm run dev &
sleep 2
curl -sf http://localhost:5173/ > /dev/null && echo "dev server OK"
```

- [x] **Step 3: Playwright golden-path walkthrough**

Using the same headless-Chromium approach as the earlier CSS-fix verification in this project (`playwright` installed to a scratch directory, driving `http://localhost:5173`), against a real PDF:

1. Upload a PDF, select text → click **Dive deeper**. Confirm: the selection is now a highlight with a "Dive ↗" badge; the layout switches to the split view; the breadcrumb shows `<fileName> › <selection>`; the right pane shows a streaming reply starting with the opening message.
2. Select text inside that reply → click **Dive deeper** again. Confirm: the pane window slides to show the panel-1 pane on the left and a new panel-2 pane on the right; the breadcrumb now has 3 crumbs.
3. Click the panel-1 breadcrumb crumb. Confirm: the window becomes `[PDF, panel 1]`.
4. Click the root (fileName) breadcrumb crumb. Confirm: the app returns to the normal sidebar+full-width-PDF layout (Deep Dive mode fully exited).
5. Click the "Dive ↗" badge on the original highlight (in the PDF or the sidebar). Confirm: re-enters the split view at `[PDF, panel 1]`.
6. Select text → click **Quick meaning**. Confirm: an inline answer appears in the popover; no new highlight or panel was created.
7. Select text → click **Pin**. Confirm: the selection appears in the sidebar's new Pins section; deleting it removes it.
8. Check `console --errors` (or the Playwright page's console listener) shows no uncaught exceptions across the whole walkthrough.

- [x] **Step 4: Clean up**

```bash
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
lsof -ti:4300 -sTCP:LISTEN | xargs -r kill
```

- [x] **Step 5: Report**

Summarize which of Step 3's 8 checks passed, and note explicitly if the `claude` CLI wasn't available/logged in in this environment (in which case checks 1, 6 depend on live model output and should be called out as unverified rather than claimed as passing).

