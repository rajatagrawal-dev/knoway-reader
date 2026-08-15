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
