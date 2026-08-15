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
