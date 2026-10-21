import { lookup } from "node:dns/promises";
import net from "node:net";

// Fetches web resources for "Add from URL" (src/web/): the page itself, and
// then the pictures, stylesheets and fonts it uses. The browser can't fetch
// them directly (other sites don't send CORS headers), so they come through
// here. Nothing is parsed on this side — it hands back the bytes, the
// content type and the URL they finally came from, after redirects.

// A page may turn out to be a whole PDF textbook; a picture or stylesheet
// never needs to be this big.
export const MAX_BYTES = { page: 300 * 1024 * 1024, asset: 40 * 1024 * 1024 };
const MAX_REDIRECTS = 10;
const HEADERS_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 30_000; // between chunks of a large body

// Sites serve a stripped-down page (or none) to clients that don't look like
// a browser; the reader is asking for one page, as a browser would.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const ACCEPT = {
  page: "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,application/epub+zip,*/*;q=0.8",
  asset: "image/avif,image/webp,image/apng,image/svg+xml,image/*,text/css,*/*;q=0.8",
};

export class WebFetchError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// ---- Which hosts may be fetched ------------------------------------------------

function ipv4Parts(ip) {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

// Loopback: this machine, including this very server.
export function isLoopbackAddress(ip) {
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1") return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isLoopbackAddress(mapped[1]) : false;
  }
  const parts = ipv4Parts(ip);
  return parts !== null && parts[0] === 127;
}

// Private, link-local and other addresses that aren't on the public internet.
export function isPrivateAddress(ip) {
  if (isLoopbackAddress(ip)) return true;
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return lower === "::" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  const parts = ipv4Parts(ip);
  if (!parts) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

async function addressesOf(hostname, resolve) {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) return [bare];
  if (bare === "localhost" || bare.endsWith(".localhost")) return ["127.0.0.1"];
  try {
    const results = await resolve(bare, { all: true, verbatim: true });
    return results.map((entry) => entry.address);
  } catch {
    throw new WebFetchError(`Couldn't find the site ${bare}.`, 502);
  }
}

// The reader typed (or pasted) the page's URL, so a page on their own
// network — a self-hosted wiki, a local docs server — is theirs to fetch.
// What a page asks for in turn (its pictures, stylesheets) may reach the
// local network only if the page itself lives there: a public page doesn't
// get to make this machine probe the reader's router.
export async function checkDestination(url, { purpose, referer, resolve = lookup }) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebFetchError("Only http and https addresses can be added.", 400);
  }
  if (url.username || url.password) throw new WebFetchError("Addresses with a user name or password aren't supported.", 400);
  if (purpose === "page") return;
  const addresses = await addressesOf(url.hostname, resolve);
  if (!addresses.some((ip) => isPrivateAddress(ip))) return;
  let refererIsLocal = false;
  if (referer) {
    try {
      const refAddresses = await addressesOf(new URL(referer).hostname, resolve);
      refererIsLocal = refAddresses.some((ip) => isPrivateAddress(ip));
    } catch {
      refererIsLocal = false;
    }
  }
  if (!refererIsLocal) throw new WebFetchError("A public page can't load resources from the local network.", 403);
}

// ---- Fetching ---------------------------------------------------------------------

async function readBody(response, limit, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new WebFetchError(`It's too large to add (${Math.round(declared / 1024 / 1024)} MB).`, 413);
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    let timer;
    const idle = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new WebFetchError("The site stopped sending data.", 504)), IDLE_TIMEOUT_MS);
    });
    let result;
    try {
      result = await Promise.race([reader.read(), idle]);
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (signal?.aborted) {
      void reader.cancel().catch(() => {});
      throw new WebFetchError("Cancelled.", 499);
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      throw new WebFetchError(`It's too large to add (over ${Math.round(limit / 1024 / 1024)} MB).`, 413);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function describeStatus(status, host) {
  if (status === 401 || status === 403) return `${host} refused the request (${status}). The page may need you to sign in, or the site may block downloads like this one.`;
  if (status === 404 || status === 410) return `${host} says there's no such page (${status}).`;
  if (status === 429) return `${host} is limiting requests (429). Try again in a little while.`;
  if (status >= 500) return `${host} had an error (${status}). Try again later.`;
  return `${host} answered ${status}.`;
}

// Follows redirects one hop at a time, so every hop gets the same checks.
export async function fetchResource(
  rawUrl,
  { purpose = "page", referer, signal, fetchImpl = fetch, resolve = lookup } = {},
) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebFetchError("That isn't a valid web address.", 400);
  }
  const limit = MAX_BYTES[purpose] ?? MAX_BYTES.asset;
  const requested = url.href;
  for (let hop = 0; ; hop += 1) {
    // A redirect is the site's choice, not the reader's: past the first hop,
    // a page gets the same network checks as anything it loads.
    const redirected = purpose === "page" && hop > 0;
    await checkDestination(url, {
      purpose: redirected ? "asset" : purpose,
      referer: redirected ? requested : referer,
      resolve,
    });
    const headers = {
      "User-Agent": USER_AGENT,
      Accept: ACCEPT[purpose] ?? ACCEPT.asset,
      "Accept-Language": "en-US,en;q=0.9",
    };
    if (referer) headers.Referer = referer;
    let response;
    const timeout = AbortSignal.timeout(HEADERS_TIMEOUT_MS);
    try {
      response = await fetchImpl(url, {
        headers,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw new WebFetchError("Cancelled.", 499);
      if (timeout.aborted) throw new WebFetchError(`${url.hostname} took too long to answer.`, 504);
      throw new WebFetchError(`Couldn't reach ${url.hostname}${error?.cause?.code ? ` (${error.cause.code})` : ""}.`, 502);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      void response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new WebFetchError(`${url.hostname} redirected too many times.`, 508);
      url = new URL(response.headers.get("location"), url);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const error = new WebFetchError(describeStatus(response.status, url.hostname), 502);
      error.upstreamStatus = response.status;
      throw error;
    }
    const body = await readBody(response, limit, signal);
    return {
      finalUrl: url.href,
      contentType: response.headers.get("content-type") || "application/octet-stream",
      body,
    };
  }
}

// ---- A small cache ----------------------------------------------------------------

// The same picture is fetched twice in one import — once for the book, once
// for the styled render that figures are captured from — and a retry fetches
// everything again. Assets are kept for a few minutes, within a byte budget.
export function createAssetCache({ maxBytes = 150 * 1024 * 1024, ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  let total = 0;
  const evict = (key) => {
    const entry = entries.get(key);
    if (!entry) return;
    total -= entry.value.body.byteLength;
    entries.delete(key);
  };
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (now() - entry.at > ttlMs) {
        evict(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, entry); // most recently used last
      return entry.value;
    },
    set(key, value) {
      const size = value.body.byteLength;
      if (size > maxBytes / 4) return;
      evict(key);
      entries.set(key, { value, at: now() });
      total += size;
      for (const oldest of entries.keys()) {
        if (total <= maxBytes) break;
        evict(oldest);
      }
    },
  };
}

// GET /api/web/fetch?url=…&purpose=page|asset&referer=…
export function webFetchHandler({ fetchImpl, resolve } = {}) {
  const cache = createAssetCache();
  return async (req, res) => {
    const url = (req.query?.url || "").toString();
    const purpose = req.query?.purpose === "asset" ? "asset" : "page";
    const referer = (req.query?.referer || "").toString() || undefined;
    if (!url) return res.status(400).json({ error: "url is required." });
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const key = `${purpose} ${url}`;
    try {
      const result =
        (purpose === "asset" && cache.get(key)) ||
        (await fetchResource(url, {
          purpose,
          referer,
          signal: controller.signal,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(resolve ? { resolve } : {}),
        }));
      if (purpose === "asset") cache.set(key, result);
      res.setHeader("Content-Type", result.contentType);
      res.setHeader("X-Final-Url", result.finalUrl); // URL.href is always ASCII
      res.setHeader("Access-Control-Expose-Headers", "X-Final-Url");
      // Served from this origin, a fetched page must never run as part of
      // the app: opened directly, it gets a sandbox of its own.
      res.setHeader("Content-Security-Policy", "sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=600");
      res.end(Buffer.from(result.body.buffer, result.body.byteOffset, result.body.byteLength));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error instanceof WebFetchError ? error.status : 502;
      res.status(status).json({
        error: error instanceof WebFetchError ? error.message : "Couldn't fetch that page.",
        ...(error?.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
      });
    }
  };
}
