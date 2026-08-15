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
