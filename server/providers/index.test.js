import test from "node:test";
import assert from "node:assert/strict";
import { createProvider } from "./index.js";

test("anthropic requires ANTHROPIC_API_KEY", () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.throws(() => createProvider("anthropic", { model: "claude-sonnet-5" }), /ANTHROPIC_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test("openai requires OPENAI_API_KEY", () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => createProvider("openai", { model: "gpt-5" }), /OPENAI_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  }
});

test("google requires GOOGLE_API_KEY", () => {
  const prev = process.env.GOOGLE_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    assert.throws(() => createProvider("google", { model: "gemini-3-pro" }), /GOOGLE_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.GOOGLE_API_KEY = prev;
  }
});

test("muse-spark requires MUSE_SPARK_API_KEY", () => {
  const prev = process.env.MUSE_SPARK_API_KEY;
  delete process.env.MUSE_SPARK_API_KEY;
  try {
    assert.throws(() => createProvider("muse-spark", { model: "muse-spark-1.3" }), /MUSE_SPARK_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.MUSE_SPARK_API_KEY = prev;
  }
});

test("an unknown provider name throws a clear error", () => {
  assert.throws(() => createProvider("bogus", { model: "x" }), /Unknown provider "bogus"/);
});
