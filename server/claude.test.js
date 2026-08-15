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
