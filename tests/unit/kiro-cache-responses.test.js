// Regression tests: Kiro cache accounting for openai-responses source format.
// omp calls Kiro via /v1/responses; previously applyKiroCacheAccounting bailed
// out on sourceFormat !== CLAUDE so usage rows always showed cached_tokens: 0.
import { describe, expect, it } from "vitest";

import {
  applyKiroCacheAccounting,
  buildClaudeCacheProfile,
  DEFAULT_PROMPT_CACHE_TTL_MS,
} from "../../open-sse/utils/kiroCacheTracker.js";

// Opus min-cacheable prefix is 4096 tokens (~16KB of text at the estimator's
// ~4 chars/token). Pad the instructions so the stored prefix clears the floor.
const PAD = "x".repeat(20000);

const RESPONSES_BODY = {
  model: "claude-opus-5",
  instructions: `You are a coding agent. ${PAD}`,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "first" }] },
    {
      type: "function_call",
      call_id: "call_1",
      name: "read_file",
      arguments: '{"path":"a.js"}',
    },
    { type: "function_call_output", call_id: "call_1", output: "contents" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
  ],
};

function baseUsage() {
  return { prompt_tokens: 50000, completion_tokens: 42 };
}

describe("kiroCacheTracker: openai-responses source format", () => {
  it("builds breakpoints from a responses body (turn boundaries implicit)", () => {
    const profile = buildClaudeCacheProfile(RESPONSES_BODY, 50000);
    expect(profile).not.toBeNull();
    // prelude + 4 items → breakpoints at each item (last of each is turn end;
    // every item here ends a turn group because none share a boundary).
    expect(profile.breakpoints.length).toBeGreaterThanOrEqual(1);
    // implicit TTL is the 5m default
    expect(profile.breakpoints[0].ttl).toBe(DEFAULT_PROMPT_CACHE_TTL_MS);
  });

  it("returns null for a responses body with empty input", () => {
    expect(buildClaudeCacheProfile({ model: "m", input: [] }, 1000)).toBeNull();
  });

  it("does not route Claude bodies down the responses path", () => {
    const claudeBody = {
      model: "claude-opus-5",
      messages: [{ role: "user", content: "hi" }],
    };
    // Claude path without cache_control yields no breakpoints → null
    expect(buildClaudeCacheProfile(claudeBody, 1000)).toBeNull();
  });

  it("applyKiroCacheAccounting no longer skips openai-responses requests", () => {
    // First request: creation on the stored prefix.
    const first = applyKiroCacheAccounting({
      provider: "kiro",
      sourceFormat: "openai-responses",
      body: RESPONSES_BODY,
      model: "claude-opus-5",
      connectionId: "conn-resp-1",
      usage: baseUsage(),
    });
    expect(first.cache_creation_input_tokens || first.cache_read_input_tokens).toBeGreaterThan(0);

    // Second identical request inside the TTL window: cache read.
    const second = applyKiroCacheAccounting({
      provider: "kiro",
      sourceFormat: "openai-responses",
      body: RESPONSES_BODY,
      model: "claude-opus-5",
      connectionId: "conn-resp-1",
      usage: baseUsage(),
    });
    expect(second.cache_read_input_tokens).toBeGreaterThan(0);
    // billed prompt excludes cached portion
    expect(second.prompt_tokens).toBeLessThan(baseUsage().prompt_tokens);
  });

  it("still skips non-claude non-responses formats", () => {
    const out = applyKiroCacheAccounting({
      provider: "kiro",
      sourceFormat: "openai",
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      model: "m",
      connectionId: "conn-x",
      usage: baseUsage(),
    });
    expect(out.cache_read_input_tokens).toBeUndefined();
    expect(out.cache_creation_input_tokens).toBeUndefined();
  });

  it("still skips non-kiro providers", () => {
    const out = applyKiroCacheAccounting({
      provider: "codex",
      sourceFormat: "openai-responses",
      body: RESPONSES_BODY,
      model: "m",
      connectionId: "conn-y",
      usage: baseUsage(),
    });
    expect(out.cache_read_input_tokens).toBeUndefined();
  });

  it("respects real upstream cache fields when present", () => {
    const out = applyKiroCacheAccounting({
      provider: "kiro",
      sourceFormat: "openai-responses",
      body: RESPONSES_BODY,
      model: "claude-opus-5",
      connectionId: "conn-z",
      usage: { prompt_tokens: 100, cached_tokens: 80 },
    });
    expect(out.cached_tokens).toBe(80);
    expect(out.cache_read_input_tokens).toBeUndefined();
  });
});
