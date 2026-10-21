import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./app.js";
import { checkDestination, createAssetCache, fetchResource, isLoopbackAddress, isPrivateAddress } from "./web.js";

// Every host resolves from this table instead of real DNS.
const DNS = {
  "example.com": "93.184.216.34",
  "cdn.example.com": "93.184.216.35",
  "router.lan": "192.168.1.1",
  "wiki.lan": "10.0.0.5",
};
const resolve = async (host) => {
  if (!DNS[host]) throw new Error("ENOTFOUND");
  return [{ address: DNS[host], family: 4 }];
};

// A fake fetch serving `routes` (URL → Response factory).
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    const route = routes[String(url)];
    if (!route) return new Response("missing", { status: 404 });
    return route();
  };
  return { impl, calls };
}

test("private and loopback addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) assert.ok(isLoopbackAddress(ip), ip);
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.ok(isPrivateAddress(ip), ip);
  }
  for (const ip of ["93.184.216.34", "172.32.0.1", "8.8.8.8", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("a page the reader asked for may be on their own network; what a public page loads may not", async () => {
  await checkDestination(new URL("http://wiki.lan/page"), { purpose: "page", resolve });
  await checkDestination(new URL("http://localhost:8000/book/"), { purpose: "page", resolve });
  await checkDestination(new URL("https://cdn.example.com/a.png"), { purpose: "asset", referer: "https://example.com/", resolve });
  await assert.rejects(
    checkDestination(new URL("http://router.lan/admin"), { purpose: "asset", referer: "https://example.com/post", resolve }),
    /local network/,
  );
  await assert.rejects(
    checkDestination(new URL("http://127.0.0.1:4300/api/health"), { purpose: "asset", referer: "https://example.com/", resolve }),
    /local network/,
  );
  // A page on the local network may load from it.
  await checkDestination(new URL("http://router.lan/logo.png"), { purpose: "asset", referer: "http://wiki.lan/page", resolve });
  await assert.rejects(checkDestination(new URL("file:///etc/passwd"), { purpose: "page", resolve }), /http and https/);
  await assert.rejects(checkDestination(new URL("https://u:p@example.com/"), { purpose: "page", resolve }), /password/);
});

test("fetchResource follows redirects and reports where it ended up", async () => {
  const { impl, calls } = fakeFetch({
    "https://example.com/old": () => new Response(null, { status: 301, headers: { location: "/new" } }),
    "https://example.com/new": () => new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const result = await fetchResource("https://example.com/old", { fetchImpl: impl, resolve });
  assert.equal(result.finalUrl, "https://example.com/new");
  assert.equal(result.contentType, "text/html; charset=utf-8");
  assert.equal(new TextDecoder().decode(result.body), "<p>hi</p>");
  assert.equal(calls.length, 2);
  assert.match(calls[0].headers["User-Agent"], /Mozilla/);
});

test("a public page can't redirect the fetch onto the local network", async () => {
  const { impl } = fakeFetch({
    "https://example.com/go": () => new Response(null, { status: 302, headers: { location: "http://router.lan/admin" } }),
  });
  await assert.rejects(fetchResource("https://example.com/go", { fetchImpl: impl, resolve }), /local network/);
});

test("fetchResource explains error statuses and gives up on endless redirects", async () => {
  const { impl } = fakeFetch({
    "https://example.com/private": () => new Response("no", { status: 403 }),
    "https://example.com/loop": () => new Response(null, { status: 302, headers: { location: "/loop" } }),
  });
  await assert.rejects(fetchResource("https://example.com/private", { fetchImpl: impl, resolve }), (error) => {
    assert.match(error.message, /refused the request \(403\)/);
    assert.equal(error.upstreamStatus, 403);
    return true;
  });
  await assert.rejects(fetchResource("https://example.com/missing", { fetchImpl: impl, resolve }), /no such page \(404\)/);
  await assert.rejects(fetchResource("https://example.com/loop", { fetchImpl: impl, resolve }), /redirected too many times/);
  await assert.rejects(fetchResource("not a url", { fetchImpl: impl, resolve }), /valid web address/);
});

test("fetchResource stops at the size limit", async () => {
  const big = new Uint8Array(41 * 1024 * 1024);
  const { impl } = fakeFetch({
    "https://cdn.example.com/huge.png": () => new Response(big, { headers: { "content-type": "image/png" } }),
    "https://cdn.example.com/declared.png": () =>
      new Response("x", { headers: { "content-type": "image/png", "content-length": String(500 * 1024 * 1024) } }),
  });
  await assert.rejects(
    fetchResource("https://cdn.example.com/huge.png", { purpose: "asset", referer: "https://example.com/", fetchImpl: impl, resolve }),
    /too large/,
  );
  await assert.rejects(
    fetchResource("https://cdn.example.com/declared.png", { purpose: "asset", referer: "https://example.com/", fetchImpl: impl, resolve }),
    /too large/,
  );
});

test("the asset cache keeps recent entries within its budget", () => {
  let clock = 0;
  const cache = createAssetCache({ maxBytes: 100, ttlMs: 1000, now: () => clock });
  const entry = (size) => ({ finalUrl: "u", contentType: "image/png", body: new Uint8Array(size) });
  cache.set("a", entry(20));
  cache.set("b", entry(20));
  assert.ok(cache.get("a"));
  cache.set("c", entry(20));
  cache.set("d", entry(20));
  cache.set("e", entry(20));
  cache.set("f", entry(20)); // over budget: the least recently used ("b") goes
  assert.equal(cache.get("b"), null);
  assert.ok(cache.get("a"));
  cache.set("big", entry(60)); // over a quarter of the budget: not kept
  assert.equal(cache.get("big"), null);
  clock = 5000;
  assert.equal(cache.get("a"), null); // expired
});

test("GET /api/web/fetch returns the bytes with the final URL, sandboxed", async () => {
  const { impl } = fakeFetch({
    "https://example.com/a": () => new Response(null, { status: 302, headers: { location: "https://example.com/b" } }),
    "https://example.com/b": () => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }),
  });
  const app = buildApp({ models: {}, webFetch: { fetchImpl: impl, resolve } });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/web/fetch?url=${encodeURIComponent("https://example.com/a")}`, {
      headers: { Origin: "tauri://localhost" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-final-url"), "https://example.com/b");
    assert.equal(res.headers.get("content-type"), "text/html");
    assert.equal(res.headers.get("content-security-policy"), "sandbox");
    assert.equal(res.headers.get("access-control-allow-origin"), "tauri://localhost");
    assert.match(res.headers.get("access-control-expose-headers"), /X-Final-Url/);
    assert.equal(await res.text(), "<html>ok</html>");

    const missing = await fetch(`${base}/api/web/fetch?url=${encodeURIComponent("https://example.com/nope")}`);
    assert.equal(missing.status, 502);
    assert.match((await missing.json()).error, /no such page/);

    const blocked = await fetch(
      `${base}/api/web/fetch?purpose=asset&referer=${encodeURIComponent("https://example.com/")}&url=${encodeURIComponent("http://router.lan/x")}`,
    );
    assert.equal(blocked.status, 403);

    const bad = await fetch(`${base}/api/web/fetch`);
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
