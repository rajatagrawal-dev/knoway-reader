// Shared request timeout for the raw-fetch providers (anthropicApi.js,
// google.js). The CLI provider has always had an equivalent guard via its
// own spawn+kill timeout; this closes the same gap for HTTP ones — without
// it, a provider whose connection opens but then stalls (observed: Gemini,
// during a "high demand" condition, accepting a stream and never sending
// data or closing it) hangs the request forever with no error, leaving the
// UI stuck on "Thinking" with no way to recover short of restarting the app.
export const REQUEST_TIMEOUT_MS = 120_000;

export function withTimeoutSignal(ms = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`timed out after ${ms}ms with no response`)),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}
