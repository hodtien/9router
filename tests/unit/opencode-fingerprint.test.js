import { describe, expect, it } from "vitest";
import {
  OPENCODE_SESSION_RE,
  generateSessionId,
  generateRequestId,
  translateSessionId,
  OpenCodeExecutor,
} from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";

function makeCredentials(overrides = {}) {
  return { connectionId: "conn_test", rawHeaders: {}, ...overrides };
}

describe("OpenCode Free Session ID Format (canonical descending)", () => {
  it("generates session IDs matching ses_ + 12 hex + 14 base62 (30 chars)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("generates request IDs matching msg_ + 12 hex + 14 base62 (30 chars)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateRequestId();
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(id).toHaveLength(30);
    }
  });

  it("counter increments within the same millisecond so two requests don't collide", () => {
    const ts = 1700000000000;
    const a = generateSessionId(ts);
    const b = generateSessionId(ts);
    expect(a).not.toBe(b);
    expect(a).toMatch(OPENCODE_SESSION_RE);
    expect(b).toMatch(OPENCODE_SESSION_RE);
  });

  it("translates arbitrary session ids (UUID, foreign tool) into canonical form", () => {
    const inputs = [
      "claude:550e8400-e29b-41d4-a716-446655440000",
      "antigravity:conv-abc-123",
      "session-from-codex",
      "12345",
      "",
    ];
    for (const raw of inputs) {
      const translated = translateSessionId(raw, "claude");
      expect(translated).toMatch(OPENCODE_SESSION_RE);
      expect(translated).toHaveLength(30);
    }
  });

  it("preserves already-valid OpenCode sessions without re-hashing", () => {
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    expect(translateSessionId(valid)).toBe(valid);
    expect(translateSessionId(`  ${valid}  `)).toBe(valid);
  });
});

describe("OpenCode Free prepareRequestCredentials (request-local session)", () => {
  it("isolates request credentials from source credentials", () => {
    const executor = new OpenCodeExecutor();
    const credentials = makeCredentials();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials,
      providerSessionId: "conversation-a",
      clientTool: "claude",
    });
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = new OpenCodeExecutor();
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });
    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = new OpenCodeExecutor();
    const prepared = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("translates conversation session deterministically (same convo + tool → same ses)", () => {
    const executor = new OpenCodeExecutor();
    const first = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials(),
      providerSessionId: "conversation-a",
      clientTool: "claude",
    })._opencodeSession;
    const second = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials(),
      providerSessionId: "conversation-a",
      clientTool: "claude",
    })._opencodeSession;
    expect(first).toBe(second);
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to opencode/1.18.31 ... for non-opencode downstream clients", () => {
    const executor = new OpenCodeExecutor();
    expect(executor.buildHeaders({}).UserAgent ?? executor.buildHeaders({})["User-Agent"]).toBe(
      "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"
    );
    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe(
      "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"
    );
  });

  it("replaces bare 'opencode' UA with versioned default", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode" } });
    expect(headers["User-Agent"]).toBe(
      "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"
    );
  });

  it("upgrades outdated opencode versions (< 1.17)", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(headers["User-Agent"]).toBe(
      "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"
    );
  });

  it("preserves valid opencode versions (>= 1.17)", () => {
    const executor = new OpenCodeExecutor();
    const headers118 = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14" },
    });
    expect(headers118["User-Agent"]).toBe(
      "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14"
    );
    const headersFuture = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.19.0" } });
    expect(headersFuture["User-Agent"]).toBe("opencode/1.19.0");
  });
});

describe("OpenCode Free Upstream Gates (stream + tool fingerprint + reasoning strip)", () => {
  it("forces stream:true on chat bodies even for non-stream clients", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      false,
      makeCredentials(),
    );
    expect(out.stream).toBe(true);
  });

  it("injects the file-search quartet {bash,glob,grep,read} into chat bodies without tools", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      true,
      makeCredentials(),
    );
    const names = out.tools.map((t) => t.function?.name);
    for (const required of ["bash", "glob", "grep", "read"]) {
      expect(names).toContain(required);
    }
  });

  it("preserves caller chat tools and only appends missing fingerprint names", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      {
        model: "mimo-v2.5-free",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "my_tool", description: "m", parameters: { type: "object", properties: {} } } }],
      },
      true,
      makeCredentials(),
    );
    const names = out.tools.map((t) => t.function?.name);
    expect(names[0]).toBe("my_tool");
    for (const required of ["bash", "glob", "grep", "read"]) {
      expect(names).toContain(required);
    }
  });

  it("injects fingerprint into Responses bodies and keeps stream/store gates", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      false,
      makeCredentials(),
    );
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    const names = out.tools.map((t) => t.name);
    for (const required of ["bash", "glob", "grep", "read"]) {
      expect(names).toContain(required);
    }
  });

  it("strips prior-turn reasoning items carrying encrypted_content from input", () => {
    const executor = new OpenCodeExecutor();
    const model = "muse-spark-1.3-contributor-free";
    const body = {
      model,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "say hi" }] },
        { type: "reasoning", id: "rs_123", encrypted_content: "ENC_BLOB_TURN_1" },
        { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    };
    const out = executor.transformRequest(model, body, true, makeCredentials());
    expect(out.input.some((i) => i.type === "reasoning")).toBe(false);
    expect(JSON.stringify(out.input)).not.toContain("ENC_BLOB_TURN_1");
  });

  it("injects the fingerprint into Anthropic Messages bodies (union-alpha)", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "union-alpha",
      { model: "union-alpha", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
      true,
      makeCredentials(),
    );
    const names = (out.tools || []).map((t) => t.function?.name ?? t.name);
    for (const required of ["bash", "glob", "grep", "read"]) {
      expect(names).toContain(required);
    }
  });

  it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS["opencode"]?.forceStream).toBe(true);
  });
});
