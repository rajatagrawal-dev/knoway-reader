import type { GlossaryOrigin, GlossarySource, OriginKind } from "./types";

// The model replies in a small line format (see prompts.ts) rather than
// JSON, so the definition can be shown while it streams and any provider
// can produce it:
//
//   SOURCE: defined
//   ORIGIN: technical; quantum computing
//   <definition>
//   ---
//   DEFINED_IN: S3
//   ALIASES: EPR pair; Bell state
//   LITERAL: none
//   REFERENCE: W1
//
// Parsed leniently on every chunk: a missing header or trailer line just
// leaves its field unset.

export interface ParsedGlossaryReply {
  source?: GlossarySource;
  origin?: GlossaryOrigin;
  definition: string;
  definedIn?: string; // excerpt label, e.g. "S3"
  aliases: string[];
  literal?: string;
  reference?: string; // reference entry label, e.g. "D2" or "W1"
}

const SOURCES: GlossarySource[] = ["defined", "inferred", "general"];
const ORIGIN_KINDS: OriginKind[] = ["common", "technical", "foreign", "name", "abbreviation"];
const HEADER_LABELS = ["SOURCE:", "ORIGIN:"];
const HEADER_LINE = /^\s*(SOURCE|ORIGIN)\s*:\s*(.*)$/i;
const TRAILER_LINE = /^\s*(DEFINED_IN|ALIASES|LITERAL|REFERENCE)\s*:\s*(.*)$/i;
const NONE = /^(none|n\/a|-)?\.?$/i;

// "technical; quantum computing", "foreign (Latin)", "common - English".
export function parseOrigin(value: string): GlossaryOrigin | undefined {
  const match = value.trim().match(/^([a-z]+)\s*(.*)$/i);
  const kind = match?.[1].toLowerCase() as OriginKind | undefined;
  if (!kind || !ORIGIN_KINDS.includes(kind)) return undefined;
  const detail = match![2]
    .replace(/^[\s;:,—–(-]+|[\s).;]+$/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return detail && !NONE.test(detail) ? { kind, detail } : { kind };
}

export function parseGlossaryReply(raw: string): ParsedGlossaryReply {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let source: GlossarySource | undefined;
  let origin: GlossaryOrigin | undefined;

  // Header lines, before the definition.
  let first = 0;
  for (; first < lines.length; first++) {
    const line = lines[first];
    if (line.trim() === "") continue;
    const header = line.match(HEADER_LINE);
    if (header) {
      if (header[1].toUpperCase() === "SOURCE") {
        const value = header[2].trim().toLowerCase() as GlossarySource;
        if (SOURCES.includes(value)) source = value;
      } else {
        origin = parseOrigin(header[2]);
      }
      continue;
    }
    // Still streaming what is (so far) a header label.
    const isLast = first === lines.length - 1;
    if (isLast && HEADER_LABELS.some((label) => label.startsWith(line.trim().toUpperCase()))) {
      return { source, origin, definition: "", definedIn: undefined, aliases: [], literal: undefined, reference: undefined };
    }
    break;
  }

  const body: string[] = [];
  const trailer: string[] = [];
  let inTrailer = false;
  for (const line of lines.slice(first)) {
    if (!inTrailer && (/^\s*-{3,}\s*$/.test(line) || TRAILER_LINE.test(line))) inTrailer = true;
    (inTrailer ? trailer : body).push(line);
  }

  let definition = body.join("\n").trim();
  // Mid-stream, the "---" separator can arrive a character at a time.
  if (!inTrailer) definition = definition.replace(/\n-{1,2}$/, "").trim();

  const parsed: ParsedGlossaryReply = {
    source,
    origin,
    definition,
    definedIn: undefined,
    aliases: [],
    literal: undefined,
    reference: undefined,
  };
  for (const line of trailer) {
    const field = line.match(TRAILER_LINE);
    if (!field) continue;
    const value = field[2].trim();
    switch (field[1].toUpperCase()) {
      case "DEFINED_IN": {
        const label = value.match(/S\d+/i);
        if (label) parsed.definedIn = label[0].toUpperCase();
        break;
      }
      case "ALIASES":
        if (!NONE.test(value)) {
          parsed.aliases = value
            .split(";")
            .map((alias) => alias.trim().replace(/^["']|["']$/g, ""))
            .filter((alias) => alias && !NONE.test(alias));
        }
        break;
      case "LITERAL": {
        const literal = value.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
        if (literal && !NONE.test(literal)) parsed.literal = literal;
        break;
      }
      case "REFERENCE": {
        const label = value.match(/\b[DW]\d+\b/i);
        if (label) parsed.reference = label[0].toUpperCase();
        break;
      }
    }
  }
  return parsed;
}
