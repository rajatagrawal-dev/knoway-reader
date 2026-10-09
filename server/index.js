import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { buildApp } from "./app.js";
import { createDiveModels } from "./models.js";
import { createReferenceLookup } from "./reference.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Provider API keys and DIVE_/QUICK_ PROVIDER/MODEL overrides live in .env.
// In source layout that's next to package.json, one directory up from this
// file; the bundled desktop build (see scripts/build-server.mjs) flattens
// everything into one directory, so it copies .env alongside the bundled
// server.mjs instead — try that layout first, then fall back to the source
// one.
for (const candidate of [path.join(__dirname, ".env"), path.join(__dirname, "..", ".env")]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    // try the next candidate — fine if neither exists; a provider missing its key fails with a clear error
  }
}

const PORT = process.env.PORT || 4300;

const app = buildApp({ models: createDiveModels(), lookupReference: createReferenceLookup() });

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "..", "dist")));
}

app.listen(PORT, () => {
  console.log(`Deep Dive API listening on http://localhost:${PORT}`);
});
