// Bundles server/index.js (Express app + its dependencies, e.g. express)
// into a single ESM file the Tauri desktop build spawns via `node` at
// runtime. Node builtins (node:fs, node:path, ...) stay external/unbundled.
import { build } from "esbuild";
import { copyFileSync, existsSync } from "node:fs";

await build({
  entryPoints: ["server/index.js"],
  outfile: "src-tauri/resources/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});

// Bundling flattens server/index.js from server/ into src-tauri/resources/,
// one directory shallower than its source location — so its `../.env`
// lookup (see server/index.js) would miss this project's .env entirely once
// packaged. Copy it alongside server.mjs so the same relative lookup keeps
// working, and Tauri (via the "resources/*" glob in tauri.conf.json) bundles
// it into the app. Skipped when absent — the server then starts, but each
// role fails until its provider's API key is set.
if (existsSync(".env")) {
  copyFileSync(".env", "src-tauri/resources/.env");
}
