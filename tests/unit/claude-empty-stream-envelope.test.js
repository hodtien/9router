// Regression: an empty/stalled Claude-target stream must not close without a
// message_start — clients error "stream ended before message_start". The
// flush() guard synthesizes a minimal complete envelope when zero events were
// emitted.
import { describe, expect, it } from "vitest";

import { createSSEStream } from "../../open-sse/utils/stream.js";

async function collect(stream, chunks) {
  const w = stream.writable.getWriter();
  const r = stream.readable.getReader();
  const out = [];
  const dec = new TextDecoder();
  const pump = (async () => {
    for (const c of chunks) await w.write(new TextEncoder().encode(c));
    await w.close();
  })();
  while (true) {
    const { done, value } = await r.read();
    if (done) break;
    out.push(dec.decode(value));
  }
  await pump;
  return out.join("");
}

describe("createSSEStream empty-claude envelope", () => {
  it("synthesizes message_start..message_stop when upstream yields no events", async () => {
    // Upstream sends only a comment line (heartbeat) — nothing translatable.
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "openai",
      sourceFormat: "claude",
      provider: "kiro",
      model: "claude-opus-5",
      connectionId: "c1",
      body: { model: "claude-opus-5", messages: [] },
    });
    const text = await collect(stream, [": kiro-validation\n\n"]);
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
    expect(text).toContain('"stop_reason":"end_turn"');
  });

  it("does NOT synthesize when real events were already emitted", async () => {
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "openai",
      sourceFormat: "claude",
      provider: "kiro",
      model: "claude-opus-5",
      connectionId: "c2",
      body: { model: "claude-opus-5", messages: [] },
    });
    // A complete openai-style chunk → translator emits message_start etc.
    const chunk = "data: " + JSON.stringify({
      id: "chatcmpl-abc123",
      model: "claude-opus-5",
      choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
    }) + "\n\n";
    const text = await collect(stream, [chunk, "data: [DONE]\n\n"]);
    // exactly one message_start (no duplicate synthesis)
    const starts = (text.match(/event: message_start/g) || []).length;
    expect(starts).toBe(1);
  });

  it("does not touch non-claude source formats", async () => {
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "openai",
      sourceFormat: "openai",
      provider: "x",
      model: "gpt-5",
      connectionId: "c3",
      body: { model: "gpt-5", messages: [] },
    });
    const text = await collect(stream, [": keep-alive\n\n"]);
    expect(text).not.toContain("message_start");
  });
<<<<<<< HEAD
=======

  it("synthesizes message_stop when upstream emits message_start but never closes", async () => {
    // Partial stream: upstream sent message_start + a few content blocks then
    // abruptly closed (client abort, network drop, upstream cancel). Without the
    // synthesis guard, Claude clients error "stream ended before message_stop".
    const stream = createSSEStream({
      mode: "translate",
      targetFormat: "openai",
      sourceFormat: "claude",
      provider: "kiro",
      model: "claude-opus-5",
      connectionId: "c4",
      body: { model: "claude-opus-5", messages: [] },
    });
    const partial = [
      "event: message_start\n",
      'data: {"type":"message_start","message":{"id":"m1","role":"assistant","content":[]}}\n\n',
      "event: content_block_start\n",
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      "event: content_block_delta\n",
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      // NO message_stop — upstream was cut off
    ].join("");
    const text = await collect(stream, [partial]);
    // Real content blocks flowed through…
    expect(text).toContain("event: message_start");
    // …and the guard synthesized the terminal so the client sees a clean end.
    expect(text).toContain("event: message_stop");
    const stops = (text.match(/event: message_stop/g) || []).length;
    expect(stops).toBe(1);
  });
>>>>>>> fix/stream-partial-terminal-synthesis
});
