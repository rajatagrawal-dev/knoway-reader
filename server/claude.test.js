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
    capture.stdinWritten = "";
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: (chunk) => { capture.stdinWritten += chunk; },
      end: () => {},
    };
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

test("streamDiveReply sends an image via stdin stream-json when a message has one", async () => {
  const capture = {};
  const lines = [JSON.stringify({ type: "result", is_error: false, result: "it's a cat" })];
  const models = createDiveModels(fakeSpawn(capture, lines));

  const out = await models.streamDiveReply({
    system: "SYS",
    messages: [
      { role: "user", content: "what is this?", image: { mediaType: "image/png", data: "AAAA" } },
    ],
    onText: () => {},
  });

  assert.equal(out, "it's a cat");
  const a = capture.args;
  assert.ok(a.includes("--input-format"));
  assert.equal(a[a.indexOf("--input-format") + 1], "stream-json");
  assert.equal(a[a.length - 1], "stream-json"); // --input-format stream-json, no flattened prompt positional arg
  assert.equal(a.at(-2), "--input-format");

  const sent = JSON.parse(capture.stdinWritten.trim());
  assert.equal(sent.type, "user");
  assert.equal(sent.message.role, "user");
  assert.equal(sent.message.content[0].type, "text");
  assert.equal(sent.message.content[0].text, "what is this?");
  assert.deepEqual(sent.message.content[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  });
});

test("streamDiveReply resends the image on every call, attached to the full history", async () => {
  const capture = {};
  const lines = [JSON.stringify({ type: "result", is_error: false, result: "ok" })];
  const models = createDiveModels(fakeSpawn(capture, lines));

  await models.streamDiveReply({
    system: "SYS",
    messages: [
      { role: "user", content: "what is this?", image: { mediaType: "image/png", data: "AAAA" } },
      { role: "assistant", content: "a cat" },
      { role: "user", content: "what breed?" },
    ],
    onText: () => {},
  });

  const sent = JSON.parse(capture.stdinWritten.trim());
  assert.match(sent.message.content[0].text, /Previous conversation:/);
  assert.match(sent.message.content[0].text, /User: what is this\?/);
  assert.match(sent.message.content[0].text, /Assistant: a cat/);
  assert.match(sent.message.content[0].text, /User: what breed\?/);
  assert.equal(sent.message.content[1].source.data, "AAAA");
});

test("streamDiveReply strips null bytes from argv strings before spawning", async () => {
  // Node's execve rejects any argv string containing a NUL byte; pdf.js text
  // extraction can emit one for a glyph with no font encoding mapping, and
  // that lands straight in the system prompt.
  const capture = {};
  const models = createDiveModels(
    fakeSpawn(capture, [JSON.stringify({ type: "result", is_error: false, result: "ok" })])
  );
  await models.streamDiveReply({
    system: "before\u0000after",
    messages: [{ role: "user", content: "hi\u0000there" }],
    onText: () => {},
  });
  const a = capture.args;
  assert.equal(a[a.indexOf("--system-prompt") + 1], "beforeafter");
  assert.equal(a[a.length - 1], "hithere");
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
