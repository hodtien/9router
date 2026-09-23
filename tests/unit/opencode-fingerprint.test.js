import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyFingerprintTools,
  concealFingerprintToolNames,
  appendMissingFingerprintTools,
  fingerprintToolKey,
  restoreToolNames,
  takeRenamedToolNames,
  OPENCODE_FINGERPRINT_TOOLS,
} from "../../open-sse/utils/opencodeFingerprint.js";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: fetchMock }));

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

  it("scopes tool observations only by a caller-supplied OpenCode session", () => {
    const executor = new OpenCodeExecutor();
    const synthesized = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials(),
      providerSessionId: "conversation-a",
    });
    const supplied = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hi" }] },
      credentials: makeCredentials({ rawHeaders: { "X-Session-Id": " caller-session " } }),
      providerSessionId: "conversation-a",
    });

    expect(synthesized._opencodeContractSession).toBeUndefined();
    expect(supplied._opencodeContractSession).toBe("caller-session");
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses stable versioned defaults without rotating caller identity", () => {
    const executor = new OpenCodeExecutor();
    const first = executor.buildHeaders({});
    const second = executor.buildHeaders({});
    expect(first["User-Agent"]).toBe("opencode/1.18.31");
    expect(second["User-Agent"]).toBe(first["User-Agent"]);
    expect(first["x-opencode-client"]).toBe("desktop");
  });

  it("honors configured defaults and repairs a stale UA only for gated models", () => {
    vi.stubEnv("OPENCODE_USER_AGENT", "opencode-cli/1.0.0");
    vi.stubEnv("OPENCODE_CLIENT", "cli");
    vi.stubEnv("OPENCODE_PROJECT", "project-test");
    const executor = new OpenCodeExecutor();
    const free = executor.buildHeaders({}, false, null, "mimo-v2.5-free");
    const paid = executor.buildHeaders({}, false, null, "paid-model");
    expect(free["User-Agent"]).toBe("opencode/1.18.31");
    expect(free.Accept).toBe("text/event-stream");
    expect(free["x-opencode-client"]).toBe("cli");
    expect(free["x-opencode-project"]).toBe("project-test");
    expect(paid["User-Agent"]).toBe("opencode-cli/1.0.0");
  });

  it("supports disabling header synthesis", () => {
    vi.stubEnv("OPENCODE_SYNTHESIZE_CLI_HEADERS", "false");
    const headers = new OpenCodeExecutor().buildHeaders({});
    expect(headers).not.toHaveProperty("User-Agent");
    expect(headers).not.toHaveProperty("x-opencode-client");
    expect(headers).not.toHaveProperty("x-opencode-project");
  });

  it("preserves a downstream opencode UA verbatim and does not rotate it", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.19.0" },
    });
    expect(headers["User-Agent"]).toBe("opencode/1.19.0");
  });

  it("preserves a downstream x-opencode-client verbatim and does not rotate it", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders({
      rawHeaders: { "x-opencode-client": "tui" },
    });
    expect(headers["x-opencode-client"]).toBe("tui");
  });

  it("upgrades outdated opencode versions (< 1.17) to the stable default", () => {
    const executor = new OpenCodeExecutor();
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(headers["User-Agent"]).toMatch(/^opencode\/1\.18\./);
  });
});

describe("OpenCode free-tier request contract and Responses normalization", () => {
  it("forces stream and adds one protocol-correct placeholder for gated Chat requests", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      false,
      makeCredentials(),
    );
    expect(out.stream).toBe(true);
    expect(out.tools.map((tool) => tool.function?.name)).toEqual([
      "_noop", "bash", "glob", "grep", "read",
    ]);
  });

  it("preserves caller Chat tools without appending placeholders", () => {
    const executor = new OpenCodeExecutor();
    const tool = { type: "function", function: { name: "my_tool", description: "m", parameters: { type: "object", properties: {} } } };
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }], tools: [tool] },
      true,
      makeCredentials(),
    );
    expect(out.tools[0]).toEqual(tool);
    expect(out.tools.slice(1).map((item) => item.function.name)).toEqual([
      "bash", "glob", "grep", "read",
    ]);
  });

  it("keeps the free-tier contract for thinking-suffixed models", () => {
    const out = new OpenCodeExecutor().transformRequest(
      "mimo-v2.5-free(high)",
      { messages: [{ role: "user", content: "hi" }] },
      true,
      makeCredentials(),
    );
    expect(out.tools.map((tool) => tool.function?.name)).toEqual([
      "_noop", "bash", "glob", "grep", "read",
    ]);
  });

  it("passes configured proxy options to the native transport", async () => {
    const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
    proxyAwareFetch.mockClear();
    proxyAwareFetch.mockResolvedValueOnce(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const proxyOptions = {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.invalid:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "https://relay.invalid/relay",
    };
    await new OpenCodeExecutor().execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: makeCredentials(),
      proxyOptions,
    });
    expect(proxyAwareFetch.mock.calls[0][2]).toBe(proxyOptions);
  });

  it("uses the flat placeholder shape for gated Responses requests", () => {
    const executor = new OpenCodeExecutor();
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      false,
      makeCredentials(),
    );
    expect(out.stream).toBe(true);
    expect(out.store).toBe(false);
    expect(out.tools.map((tool) => tool.name)).toEqual([
      "_noop", "bash", "glob", "grep", "read",
    ]);
  });

  it("strips prior-turn Responses reasoning items carrying encrypted_content", () => {
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
    expect(out.input.some((item) => item.type === "reasoning")).toBe(false);
    expect(JSON.stringify(out.input)).not.toContain("ENC_BLOB_TURN_1");
  });

  it("keeps streaming scoped to the gated free-tier model", () => {
    const executor = new OpenCodeExecutor();
    const free = executor.transformRequest(
      "mimo-v2.5-free",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      makeCredentials(),
    );
    const paid = executor.transformRequest(
      "paid-model",
      { messages: [{ role: "user", content: "hi" }] },
      false,
      makeCredentials(),
    );

    expect(free.stream).toBe(true);
    expect(paid.stream).toBe(false);
  });

  it("does not declare provider-wide streaming", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBeUndefined();
  });
});

const CC_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "WebFetch"];
const flat = (names) => names.map((name) => ({ type: "function", name }));
const chat = (names) => names.map((name) => ({ type: "function", function: { name } }));

describe("opencodeFingerprint — request side", () => {
  it("renames capitalised quartet members to lowercase", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    const names = body.tools.map((tool) => tool.name);

    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(names).toContain("Edit");
    expect(map.get("bash")).toBe("Bash");
  });

  it("removes quartet case duplicates without dropping unrelated case variants", () => {
    const body = { tools: flat(["Bash", "bash", "Glob", "grep", "Read", "Foo", "foo"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "bash")).toHaveLength(1);
    expect(names).toContain("Foo");
    expect(names).toContain("foo");
  });

  it("preserves tool count when a complete quartet is only renamed", () => {
    const body = { tools: flat(CC_TOOLS) };
    applyFingerprintTools(body, true);
    expect(body.tools).toHaveLength(CC_TOOLS.length);
  });

  it("handles the nested chat shape without dropping .function", () => {
    const body = { tools: chat(CC_TOOLS) };
    applyFingerprintTools(body, false);

    const names = body.tools.map((tool) => tool.function.name);
    expect(names).toContain("bash");
    expect(names).not.toContain("Bash");
    expect(body.tools[1].function.name).toBe("bash");
  });

  it("injects all four fingerprint tools when the body carries no tools", () => {
    const body = { tools: [] };
    applyFingerprintTools(body, true);

    expect(body.tools.map((tool) => tool.name).sort()).toEqual([...OPENCODE_FINGERPRINT_TOOLS].sort());
    expect(body.tool_choice).toBe("auto");
  });

  it("preserves the chat no-tool default tool_choice=none", () => {
    const body = {};
    applyFingerprintTools(body, false);

    expect(body.tools.map((tool) => tool.function.name)).toEqual(OPENCODE_FINGERPRINT_TOOLS);
    expect(body.tool_choice).toBe("none");
  });

  it("does not invent a chat tool_choice when the caller already supplied tools", () => {
    const body = { tools: chat(["Edit"]) };
    applyFingerprintTools(body, false);
    expect(body.tool_choice).toBeUndefined();
  });

  it("appends only genuinely missing quartet members", () => {
    const body = { tools: flat(["Bash", "Read", "terminal"]) };
    applyFingerprintTools(body, true);

    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("terminal");
    expect(body.tools).toHaveLength(5);
  });

  it("retargets flat tool_choice that points at a renamed tool", () => {
    const body = { tools: flat(CC_TOOLS), tool_choice: { type: "function", name: "Bash" } };
    applyFingerprintTools(body, true);
    expect(body.tool_choice.name).toBe("bash");
  });

  it("retargets nested tool_choice that points at a renamed tool", () => {
    const body = {
      tools: chat(CC_TOOLS),
      tool_choice: { type: "function", function: { name: "Read" } },
    };
    applyFingerprintTools(body, false);
    expect(body.tool_choice.function.name).toBe("read");
  });

  it("records the rename map against the body for the response side", () => {
    const body = { tools: flat(CC_TOOLS) };
    const map = applyFingerprintTools(body, true);
    expect(takeRenamedToolNames(body)).toBe(map);
  });

  it("never throws on malformed tools", () => {
    for (const tools of [null, undefined, "nope", [null, 42, []], [{}, { name: "" }]]) {
      expect(() => concealFingerprintToolNames(tools)).not.toThrow();
      expect(() => appendMissingFingerprintTools(tools, true)).not.toThrow();
    }
  });
});

describe("opencodeFingerprint — response side", () => {
  const map = new Map([["bash", "Bash"], ["grep", "Grep"], ["read", "Read"]]);

  it("restores names in Claude content_block_start chunks", () => {
    const chunk = {
      type: "content_block_start",
      content_block: { type: "tool_use", name: "bash", id: "t1" },
    };
    const out = restoreToolNames(chunk, map);

    expect(out.content_block.name).toBe("Bash");
    expect(chunk.content_block.name).toBe("bash");
  });

  it("recursively restores streaming chunks inside arrays", () => {
    const chunks = [{
      choices: [{ delta: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } }],
    }];
    const out = restoreToolNames(chunks, map);
    expect(out[0].choices[0].delta.tool_calls[0].function.name).toBe("Grep");
  });

  it("restores names in Claude non-streaming bodies", () => {
    const body = { type: "message", content: [{ type: "tool_use", name: "bash", input: {} }] };
    expect(restoreToolNames(body, map).content[0].name).toBe("Bash");
  });

  it("restores names in Chat Completions message and delta shapes", () => {
    const body = {
      choices: [
        { message: { tool_calls: [{ function: { name: "grep", arguments: "{}" } }] } },
        { delta: { tool_calls: [{ function: { name: "read", arguments: "{}" } }] } },
      ],
    };
    const out = restoreToolNames(body, map);

    expect(out.choices[0].message.tool_calls[0].function.name).toBe("Grep");
    expect(out.choices[1].delta.tool_calls[0].function.name).toBe("Read");
  });

  it("restores names in Responses final output items", () => {
    const body = { output: [{ type: "function_call", name: "bash", call_id: "c1" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Bash");
  });

  it("restores names in Responses streaming output_item events", () => {
    const event = {
      type: "response.output_item.added",
      item: { type: "function_call", name: "read", call_id: "c1" },
    };
    expect(restoreToolNames(event, map).item.name).toBe("Read");
  });

  it("is a no-op without a map or with an empty map", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    expect(restoreToolNames(body, null)).toBe(body);
    expect(restoreToolNames(body, new Map())).toBe(body);
  });

  it("leaves unknown tool names untouched", () => {
    const body = { output: [{ type: "function_call", name: "Edit" }] };
    expect(restoreToolNames(body, map).output[0].name).toBe("Edit");
  });
});

describe("fingerprintToolKey", () => {
  it("maps quartet case/whitespace variants and rejects other tools", () => {
    expect(fingerprintToolKey("Bash")).toBe("bash");
    expect(fingerprintToolKey(" bash ")).toBe("bash");
    expect(fingerprintToolKey("GLOB")).toBe("glob");
    expect(fingerprintToolKey("Read")).toBe("read");
    expect(fingerprintToolKey("Edit")).toBe("");
    expect(fingerprintToolKey("terminal")).toBe("");
    expect(fingerprintToolKey(null)).toBe("");
  });

  it("does not automatically retry a classified free-tier 429", async () => {
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ type: "FreeUsageLimitError" }), {
      status: 429,
      headers: { "content-type": "application/json" },
    }));
    const result = await new OpenCodeExecutor().execute({
      model: "big-pickle",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: makeCredentials(),
    });

    expect(result.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records caller tool-name restoration on the executor request body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: chat(["Bash", "Glob", "Grep", "Read"]),
    };

    await new OpenCodeExecutor().execute({
      model: "big-pickle",
      body,
      stream: false,
      credentials: makeCredentials(),
    });

    expect(takeRenamedToolNames(body)?.get("bash")).toBe("Bash");
  });
});
