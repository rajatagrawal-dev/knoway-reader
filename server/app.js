import express from "express";
import { MAX_REFERENCE_WORDS } from "./reference.js";

// Streams a model reply as SSE: one {text} frame per delta, then a final
// {done, text} frame with the full reply — or an {error} frame, since the
// 200 status has already been sent by the time the model can fail.
async function streamSse(res, fallbackError, run) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const full = await run((t) => send({ text: t }));
    send({ done: true, text: full });
  } catch (err) {
    send({ error: err.message || fallbackError });
  }
  res.end();
}

// A hard ceiling on the text in one request (system prompt plus messages;
// attached images aside). The client chooses context by relevance and keeps
// far below this — it exists so a bug there can't turn into a huge bill.
// Just above the largest context any surface may send (Ask's whole-scope
// ceiling, see the grounded-study roadmap §5.2) plus instructions.
export const MAX_INPUT_CHARS = 250_000;

function textLength(system, messages) {
  return system.length + messages.reduce((sum, m) => sum + String(m?.content ?? "").length, 0);
}

function tooLarge(res, length) {
  return res.status(413).json({
    error: `Request too large: ${length.toLocaleString("en-US")} characters of text (limit ${MAX_INPUT_CHARS.toLocaleString("en-US")}).`,
  });
}

// Stateless by design: everything a request needs comes with it, and
// everything the reader keeps is stored client-side — this server is an LLM
// proxy, plus a (cached) proxy for the glossary's dictionary lookups
// (`lookupReference`, see ./reference.js).
export function buildApp({ models, lookupReference }) {
  const app = express();

  // The packaged desktop build loads the frontend from a custom scheme
  // (tauri://localhost on macOS, http://tauri.localhost on Windows — see
  // src/deepdive/api.ts's API_BASE) and calls this server via an absolute
  // http://localhost:PORT URL, which is cross-origin from the webview's
  // point of view. Without an explicit allow-list here, the browser's CORS
  // check rejects both the preflight OPTIONS request (application/json
  // POSTs aren't a CORS "simple request") and the real one — every dive
  // call fails before it reaches a route handler, surfacing in the app as a
  // generic network error ("Load failed" in WebKit). Plain http://localhost
  // dev/browser use never hits this, since Vite's proxy makes those
  // requests same-origin.
  const ALLOWED_ORIGINS = new Set(["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Area-highlight dives attach a screenshot (base64 PNG data URL) to the
  // request body, which is bigger than plain text turns.
  app.use(express.json({ limit: "15mb" }));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/dive/stream", async (req, res) => {
    const system = (req.body?.system || "").toString();
    // Optional: the part of the system prompt that changes per question,
    // kept apart so the rest can be cached (src/deepdive/prompts.ts).
    const systemSuffix = (req.body?.systemSuffix || "").toString();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!system || !messages || messages.length === 0) {
      return res.status(400).json({ error: "system and a non-empty messages array are required." });
    }
    const length = textLength(system, messages) + systemSuffix.length;
    if (length > MAX_INPUT_CHARS) return tooLarge(res, length);
    await streamSse(res, "Dive reply failed.", (onText) =>
      models.streamDiveReply({ system, ...(systemSuffix ? { systemSuffix } : {}), messages, onText }),
    );
  });

  // Whole-document questions (the Ask panel): same shape as a dive.
  app.post("/api/ask/stream", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!system || !messages || messages.length === 0) {
      return res.status(400).json({ error: "system and a non-empty messages array are required." });
    }
    const length = textLength(system, messages);
    if (length > MAX_INPUT_CHARS) return tooLarge(res, length);
    await streamSse(res, "Answer failed.", (onText) => models.streamAskReply({ system, messages, onText }));
  });

  app.post("/api/glossary/stream", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const prompt = (req.body?.prompt || "").toString();
    // A notation lookup from an area selection sends the symbol as printed.
    const images = Array.isArray(req.body?.images) ? req.body.images : [];
    if (!system || !prompt) {
      return res.status(400).json({ error: "system and prompt are required." });
    }
    const length = system.length + prompt.length;
    if (length > MAX_INPUT_CHARS) return tooLarge(res, length);
    await streamSse(res, "Glossary definition failed.", (onText) =>
      models.streamGlossary({
        system,
        messages: [{ role: "user", content: prompt, ...(images.length ? { images } : {}) }],
        onText,
      }),
    );
  });

  // What a dictionary and an encyclopedia say about a glossary term — the
  // candidates its definition's model call chooses from. Never an error for
  // "nothing found", or for a source being down: the glossary works without.
  app.get("/api/reference", async (req, res) => {
    const term = (req.query?.term || "").toString().trim();
    if (!term || term.length > 80) return res.status(400).json({ error: "term (at most 80 characters) is required." });
    if (!lookupReference || term.split(/\s+/).length > MAX_REFERENCE_WORDS) {
      return res.json({ dictionary: null, encyclopedia: [] });
    }
    try {
      res.json(await lookupReference(term));
    } catch {
      res.json({ dictionary: null, encyclopedia: [] });
    }
  });

  app.post("/api/dive/quick", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const prompt = (req.body?.prompt || "").toString();
    if (!system || !prompt) {
      return res.status(400).json({ error: "system and prompt are required." });
    }
    const length = system.length + prompt.length;
    if (length > MAX_INPUT_CHARS) return tooLarge(res, length);
    try {
      const answer = await models.quickAnswer({ system, prompt });
      res.json({ answer });
    } catch (err) {
      res.status(502).json({ error: err.message || "Quick meaning failed." });
    }
  });

  return app;
}
