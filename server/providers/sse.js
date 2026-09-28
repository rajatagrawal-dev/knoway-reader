// Parses a text/event-stream response body, invoking onData(payload) for
// each "data: ..." line with the prefix and surrounding whitespace
// stripped. Anthropic, OpenAI, and Gemini's streaming APIs all speak this
// format and pack everything we need into the "data:" field, so other SSE
// fields (event:, id:, retry:) are ignored.
export async function forEachSSEData(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data:")) onData(line.slice(5).trim());
      }
    }
  }
}
