// Grounding eval runner (roadmap §11). The eval itself (scripts/eval/
// grounding.ts) imports the app's TypeScript modules, so it's bundled with
// esbuild first, then run.
//
//   node scripts/eval-grounding.mjs <corpus.json> [--dry] [--judge] [--out results.json]
//                                   [--experiments a,b | all] [--each]
//
//   --dry          retrieval only: which passages would be sent, and their
//                  size — no model calls, no API key needed
//   --judge        also ask the QUICK role's model whether each cited passage
//                  supports its claim
//   --experiments  run the dive cases with these Deep Dive experiments on
//                  (names from src/deepdive/experiments.ts), or all of them
//   --each         run with no experiments, then each context experiment
//                  alone, and print a comparison
//
// Models and keys come from .env, the same DIVE_/QUICK_ settings the server
// uses. See scripts/eval/corpus.example.json for the corpus format.
import { build } from "esbuild";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
// The first argument that isn't a flag or a flag's value.
const valueFlags = new Set(["--out", "--experiments"]);
const corpusPath = args.find((arg, i) => !arg.startsWith("--") && !valueFlags.has(args[i - 1]));
if (!corpusPath) {
  console.error(
    "Usage: node scripts/eval-grounding.mjs <corpus.json> [--dry] [--judge] [--out results.json] [--experiments a,b|all] [--each]",
  );
  process.exit(1);
}
const outIndex = args.indexOf("--out");
const out = outIndex !== -1 ? args[outIndex + 1] : "grounding-eval-results.json";
const experimentsIndex = args.indexOf("--experiments");
const experimentsArg = experimentsIndex !== -1 ? args[experimentsIndex + 1] ?? "" : "";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env: fine for --dry.
}

// Inside the project, so the bundle's external packages (pdfjs-dist, the
// provider SDKs) resolve from its node_modules.
const outfile = path.resolve("node_modules/.cache/knowayreader-eval/grounding.mjs");
await build({
  entryPoints: ["scripts/eval/grounding.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  logLevel: "warning",
});

const { runEval, experimentsFromArg } = await import(pathToFileURL(outfile).href);
await runEval({
  corpusPath,
  dry: args.includes("--dry"),
  judge: args.includes("--judge"),
  out,
  experiments: experimentsFromArg(experimentsArg),
  each: args.includes("--each"),
});
