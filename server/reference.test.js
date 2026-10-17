import test from "node:test";
import assert from "node:assert/strict";
import { cleanExtract, createReferenceLookup, formOfTarget, parseWikipedia, parseWiktionary, senseText } from "./reference.js";

const link = (title, text = title) => `<a rel="mw:WikiLink" href="/wiki/${title}" title="${title}">${text}</a>`;
const PLURAL_OF_QUBIT = `<span class="form-of-definition use-with-mention">${link("Appendix:Glossary", "plural")} of <span class="form-of-definition-link"><i>${link("qubit")}</i></span></span>`;

test("senseText strips links, labels and nested sub-senses", () => {
  assert.equal(
    senseText(`The state of being ${link("entangle", "entangled")}; &quot;involved&quot;.\n<ol><li>A sub-sense.</li></ol>`),
    'The state of being entangled; "involved".',
  );
  assert.equal(senseText('<span class="usage-label-sense"></span>'), "");
});

test("formOfTarget finds the lemma behind a pointer sense", () => {
  assert.equal(formOfTarget(PLURAL_OF_QUBIT), "qubit");
  assert.equal(formOfTarget(`Alternative letter-case form of ${link("zeitgeist")}.`), "zeitgeist");
  assert.equal(formOfTarget(`A ${link("quantum bit")}; the basic unit of quantum information.`), null);
});

test("parseWiktionary keeps English and source-language senses, not loanword echoes or pointers", () => {
  const entries = parseWiktionary(
    {
      en: [{ language: "English", partOfSpeech: "Adjective", definitions: [{ definition: "For a particular purpose." }, { definition: "" }] }],
      da: [{ language: "Danish", partOfSpeech: "Adverb", definitions: [{ definition: "ad hoc (created for a particular purpose)" }] }],
      id: [{ language: "Indonesian", partOfSpeech: "Adjective", definitions: [{ definition: "for a particular purpose." }] }],
      la: [{ language: "Latin", partOfSpeech: "Phrase", definitions: [{ definition: "to this end, for this" }] }],
      pt: [{ language: "Portuguese", partOfSpeech: "Noun", definitions: [{ definition: PLURAL_OF_QUBIT }] }],
    },
    "ad hoc",
  );
  assert.deepEqual(entries, [
    { language: "English", partOfSpeech: "Adjective", senses: ["For a particular purpose."] },
    { language: "Latin", partOfSpeech: "Phrase", senses: ["to this end, for this"] },
  ]);
});

test("parseWikipedia drops disambiguation pages and keeps search order", () => {
  const pages = parseWikipedia({
    query: {
      pages: [
        { index: 2, title: "Entanglement", pageprops: { disambiguation: "" }, extract: "Entanglement may refer to:", fullurl: "u2" },
        { index: 1, title: "Quantum entanglement", extract: "Quantum entanglement is a phenomenon.", fullurl: "u1" },
        { index: 3, title: "Empty", extract: "", fullurl: "u3" },
      ],
    },
  });
  assert.deepEqual(pages, [{ title: "Quantum entanglement", extract: "Quantum entanglement is a phenomenon.", url: "u1" }]);
});

test("cleanExtract removes emptied pronunciation brackets and trims to a sentence", () => {
  assert.equal(cleanExtract("In computing, a qubit () or quantum bit is a unit."), "In computing, a qubit or quantum bit is a unit.");
  const long = `${"A sentence that goes on. ".repeat(30)}`;
  assert.ok(cleanExtract(long).length <= 420);
  assert.ok(cleanExtract(long).endsWith("."));
});

function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const route = routes.find(([pattern]) => url.includes(pattern));
    const [, status, body, headers = {}] = route ?? [null, 404, {}];
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: async () => body,
    };
  };
}

const WIKI = { query: { pages: [{ index: 1, title: "Qubit", extract: "A qubit is a unit.", fullurl: "https://en.wikipedia.org/wiki/Qubit" }] } };

test("lookup follows a plural to its lemma, retries lowercase, and caches", async () => {
  const calls = [];
  const lookup = createReferenceLookup({
    fetch: fakeFetch(
      [
        ["definition/Qubits", 404, {}],
        ["definition/qubits", 200, { en: [{ language: "English", partOfSpeech: "Noun", definitions: [{ definition: PLURAL_OF_QUBIT }] }] }],
        ["definition/qubit", 200, { en: [{ language: "English", partOfSpeech: "Noun", definitions: [{ definition: "A quantum bit." }] }] }],
        ["wikipedia.org", 200, WIKI],
      ],
      calls,
    ),
  });
  const result = await lookup("Qubits");
  assert.deepEqual(result, {
    dictionary: {
      url: "https://en.wiktionary.org/wiki/qubit",
      entries: [{ language: "English", partOfSpeech: "Noun", senses: ["A quantum bit."] }],
    },
    encyclopedia: [{ title: "Qubit", extract: "A qubit is a unit.", url: "https://en.wikipedia.org/wiki/Qubit" }],
  });
  const count = calls.length;
  assert.deepEqual(await lookup("qubits "), result);
  assert.equal(calls.length, count, "second lookup is served from the cache");
});

test("a capitalised term's own page wins over its lowercase one, both asked for at once", async () => {
  const calls = [];
  const lookup = createReferenceLookup({
    fetch: fakeFetch(
      [
        ["definition/Hamiltonian", 200, { en: [{ language: "English", partOfSpeech: "Noun", definitions: [{ definition: "An operator." }] }] }],
        ["definition/hamiltonian", 200, { en: [{ language: "English", partOfSpeech: "Adjective", definitions: [{ definition: "Of Hamilton." }] }] }],
        ["wikipedia.org", 200, WIKI],
      ],
      calls,
    ),
  });
  const result = await lookup("Hamiltonian");
  assert.equal(result.dictionary.url, "https://en.wiktionary.org/wiki/Hamiltonian");
  assert.deepEqual(result.dictionary.entries[0].senses, ["An operator."]);
  assert.ok(calls.some((url) => url.includes("definition/hamiltonian")), "lowercase asked for alongside");
});

test("a rate-limited source is left out, backed off, and not cached", async () => {
  let clock = 0;
  const calls = [];
  const lookup = createReferenceLookup({
    now: () => clock,
    fetch: fakeFetch([["wiktionary", 429, {}, { "retry-after": "30" }], ["wikipedia.org", 200, WIKI]], calls),
  });
  const first = await lookup("qubit");
  assert.equal(first.dictionary, null);
  assert.equal(first.encyclopedia.length, 1);
  const count = calls.length;
  // Within Retry-After: no requests go out at all.
  assert.deepEqual(await lookup("qubit"), { dictionary: null, encyclopedia: [] });
  assert.equal(calls.length, count);
  clock = 31_000;
  await lookup("qubit");
  assert.ok(calls.length > count, "retries once the back-off has passed");
});

test("the contact goes into the User-Agent", async () => {
  let headers;
  const lookup = createReferenceLookup({
    contact: "https://example.org/me",
    fetch: async (_url, init) => {
      headers = init.headers;
      return { status: 404, ok: false, headers: { get: () => null }, json: async () => ({}) };
    },
  });
  await lookup("x");
  assert.match(headers["User-Agent"], /^KnowayReader\/[\d.]+ \(https:\/\/example\.org\/me; /);
});

test("cleanExtract never cuts a formula in half", () => {
  const formula = `<math alttext="{\\displaystyle ${"x+".repeat(250)}y}"><mi>x</mi></math>`;
  const html = `<p>A short opening sentence here that runs on for a while to pass the minimum. Then ${formula} and more text after it goes here.</p>`;
  const out = cleanExtract(html);
  assert.ok(out.startsWith("A short opening sentence"));
  assert.ok(!out.includes("x+x"), "the formula isn't cut into");
  assert.equal((out.match(/(?<!\\)\$/g) ?? []).length % 2, 0);
});
