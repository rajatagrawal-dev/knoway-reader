import type { GlossarySource } from "./types";

// The model replies in a small line format (see prompts.ts) rather than
// JSON, so the definition can be shown while it streams and any provider
// can produce it:
//
//   SOURCE: defined
//   <definition>
//   ---
//   DEFINED_IN: S3
//   ALIASES: EPR pair; Bell state
//
// Parsed leniently on every chunk: a missing SOURCE line or trailer just
// leaves those fields unset.

export interface ParsedGlossaryReply {
  source?: GlossarySource;
  definition: string;
  definedIn?: string; // excerpt label, e.g. "S3"
  aliases: string[];
}

const SOURCES: GlossarySource[] = ["defined", "inferred", "general"];
const TRAILER_LINE = /^\s*(DEFINED_IN|ALIASES)\s*:/i;
const NONE = /^(none|n\/a|-)?$/i;

export function parseGlossaryReply(raw: string): ParsedGlossaryReply {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let source: GlossarySource | undefined;

  let first = lines.findIndex((line) => line.trim() !== "");
  if (first !== -1) {
    const sourceLine = lines[first].match(/^\s*SOURCE\s*:\s*([a-z]*)/i);
    if (sourceLine) {
      const value = sourceLine[1].toLowerCase() as GlossarySource;
      if (SOURCES.includes(value)) source = value;
      first += 1;
    } else if (lines.length === 1 && "SOURCE:".startsWith(lines[0].trim().toUpperCase())) {
      // Still streaming the first line, which is (so far) the SOURCE label.
      return { definition: "", aliases: [] };
    }
  }

  const body: string[] = [];
  const trailer: string[] = [];
  let inTrailer = false;
  for (const line of lines.slice(Math.max(first, 0))) {
    if (!inTrailer && (/^\s*-{3,}\s*$/.test(line) || TRAILER_LINE.test(line))) inTrailer = true;
    (inTrailer ? trailer : body).push(line);
  }

  let definition = body.join("\n").trim();
  // Mid-stream, the "---" separator can arrive a character at a time.
  if (!inTrailer) definition = definition.replace(/\n-{1,2}$/, "").trim();

  let definedIn: string | undefined;
  let aliases: string[] = [];
  for (const line of trailer) {
    const field = line.match(/^\s*(DEFINED_IN|ALIASES)\s*:\s*(.*)$/i);
    if (!field) continue;
    const value = field[2].trim();
    if (field[1].toUpperCase() === "DEFINED_IN") {
      const label = value.match(/S\d+/i);
      if (label) definedIn = label[0].toUpperCase();
    } else if (!NONE.test(value)) {
      aliases = value
        .split(";")
        .map((alias) => alias.trim().replace(/^["']|["']$/g, ""))
        .filter((alias) => alias && !NONE.test(alias));
    }
  }

  return { source, definition, definedIn, aliases };
}
