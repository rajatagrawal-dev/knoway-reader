// Web addresses: reading what the reader typed, telling whether two
// addresses are the same page, and sending a paper's abstract page to its
// PDF. Pure, so it can be unit-tested.

// What the reader typed or pasted, as an http(s) URL — "example.com/post"
// included — or null.
export function parseUserUrl(input: string): URL | null {
  let text = input.trim();
  if (!text || /\s/.test(text)) return null;
  // "localhost:8000/x" is a host and port, not a "localhost:" scheme.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) || /^[^/?#:]+:\d+([/?#]|$)/.test(text)) {
    // A bare host needs a dot (or to be localhost) to be taken as one.
    if (!/^(localhost|[^/?#]+\.[^/?#]+)(:\d+)?([/?#]|$)/i.test(text)) return null;
    text = `https://${text}`;
  }
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Is this pasted or dropped text a web address (and nothing else)?
export function looksLikeUrl(text: string): boolean {
  const trimmed = text.trim();
  return /^https?:\/\/\S+$/i.test(trimmed) && parseUserUrl(trimmed) !== null;
}

// Query parameters that only say where a link was shared from.
const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "msclkid", "yclid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "_hsenc", "_hsmi", "hsctatracking", "mkt_tok", "igshid", "igsh", "si",
  "ref_src", "ref_url", "oly_enc_id", "oly_anon_id", "vero_id", "vero_conv", "rb_clickid", "_ga", "_gl",
  "trk", "trkcampaign", "sc_campaign", "sc_channel", "cmpid", "s_kwcid", "wt.mc_id",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || lower.startsWith("pk_") || TRACKING_PARAMS.has(lower);
}

// The form of an address used to tell whether a page is already in the
// library: no fragment, no tracking parameters, the rest in a fixed order,
// no trailing slash, no default port.
export function canonicalizeUrl(input: string | URL): string {
  const url = new URL(String(input));
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const kept = [...url.searchParams.entries()].filter(([name]) => !isTrackingParam(name));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

// ---- arXiv ----------------------------------------------------------------------

const ARXIV_HOSTS = /^(www\.|export\.)?arxiv\.org$/i;
// New-style (2101.12345, with an optional version) and old-style
// (hep-th/9901001) identifiers.
const ARXIV_ID = /^((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?$/i;

// The arXiv identifier (with its version, if given) an abstract or PDF
// address points to.
export function arxivId(input: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    return null;
  }
  if (!ARXIV_HOSTS.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i);
  if (!match) return null;
  const id = decodeURIComponent(match[1]);
  return ARXIV_ID.test(id) ? id : null;
}

// Where to actually fetch a page from. An arXiv abstract page is a stub
// around the paper, so the paper's PDF is fetched instead.
export function rewriteKnownUrl(url: URL): URL {
  const id = arxivId(url);
  if (id && /^\/abs\//i.test(url.pathname)) return new URL(`https://arxiv.org/pdf/${id}`);
  return url;
}

export function arxivAbstractUrl(id: string): string {
  return `https://arxiv.org/abs/${id}`;
}

// ---- Naming -----------------------------------------------------------------------

// A file name for a document from the web: its title, made safe.
export function fileNameFor(title: string, extension = "pdf"): string {
  const base = title
    .normalize("NFKC")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return `${base || "Web page"}.${extension}`;
}

// The last part of an address's path, for a PDF that names itself nothing
// better: ".../papers/attention.pdf" → "attention".
export function nameFromUrl(input: string): string {
  try {
    const url = new URL(input);
    const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
    return last.replace(/\.(pdf|epub|html?|txt|text|md|markdown)$/i, "") || url.hostname;
  } catch {
    return input;
  }
}
