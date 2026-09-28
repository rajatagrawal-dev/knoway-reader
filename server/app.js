import express from "express";

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

// Stateless by design: the dive tree lives in the browser (localStorage), so
// this server has nothing to persist — it's purely an LLM proxy.
export function buildApp({ models }) {
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
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!system || !messages || messages.length === 0) {
      return res.status(400).json({ error: "system and a non-empty messages array are required." });
    }
    await streamSse(res, "Dive reply failed.", (onText) =>
      models.streamDiveReply({ system, messages, onText }),
    );
  });

  app.post("/api/glossary/stream", async (req, res) => {
    const system = (req.body?.system || "").toString();
    const prompt = (req.body?.prompt || "").toString();
    if (!system || !prompt) {
      return res.status(400).json({ error: "system and prompt are required." });
    }
    await streamSse(res, "Glossary definition failed.", (onText) =>
      models.streamGlossary({ system, messages: [{ role: "user", content: prompt }], onText }),
    );
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
