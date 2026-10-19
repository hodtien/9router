import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: fetchMock,
}));

import { getExecutor } from "../../open-sse/executors/index.js";
import {
  OPENCODE_SESSION_RE,
  OPENCODE_REQUEST_RE,
  generateSessionId,
  generateRequestId,
  translateSessionId,
  stableSessionId,
  supportsPublicSessionRefresh,
  createPublicSessionCandidate,
  publishPublicSessionCandidate,
  activePublicSessionId,
  deriveRequestId,
} from "../../open-sse/executors/opencode.js";

function makeCredentials(overrides = {}) {
  return {
    connectionId: "conn_test",
    rawHeaders: {},
    ...overrides,
  };
}

function prepare(executor, overrides = {}) {
  const credentials = overrides.credentials || makeCredentials();
  const prepared = executor.prepareRequestCredentials({
    body: overrides.body || { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
    credentials,
    providerSessionId: overrides.providerSessionId ?? "conversation-a",
    clientTool: overrides.clientTool ?? "claude",
  });
  return { credentials, prepared };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
});

describe("OpenCode Free Session ID Format", () => {
  it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateSessionId();
      expect(id).toMatch(OPENCODE_SESSION_RE);
      expect(id).toHaveLength(30);
    }
  });

  it("generates request IDs matching OpenCode canonical format (msg_ + 12 hex + 14 base62)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateRequestId();
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
      expect(id).toHaveLength(30);
    }
  });

  it("translates arbitrary sessions into valid OpenCode session format", () => {
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

describe("OpenCode Free Executor Session Resolution", () => {
  it("uses request-local session credentials without mutating source credentials", () => {
    const executor = getExecutor("opencode");
    const { credentials, prepared } = prepare(executor);

    expect(executor.constructor.name).toBe("OpenCodeExecutor");
    expect(prepared).not.toBe(credentials);
    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(credentials).not.toHaveProperty("_opencodeSession");
    expect(executor).not.toHaveProperty("_currentSessionId");
  });

  it("preserves valid native x-opencode-session header case-insensitively", () => {
    const executor = getExecutor("opencode");
    const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
    });

    expect(prepared._opencodeSession).toBe(valid);
  });

  it("translates invalid native x-opencode-session header into a valid session", () => {
    const executor = getExecutor("opencode");
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
    });

    expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(prepared._opencodeSession).not.toBe("invalid-session-uuid");
  });

  it("preserves valid x-session-id aliases while preferring native OpenCode sessions", () => {
    const executor = getExecutor("opencode");
    const alias = "ses_f534dfae8ffeCy4Ee4tLWNygDc";
    const native = generateSessionId();
    expect(prepare(executor, { credentials: makeCredentials({ rawHeaders: { "x-session-id": alias } }) }).prepared._opencodeSession).toBe(alias);
    expect(prepare(executor, { credentials: makeCredentials({ rawHeaders: { "x-session-id": alias, "x-opencode-session": native } }) }).prepared._opencodeSession).toBe(native);
  });

  it("translates conversation session deterministically", () => {
    const executor = getExecutor("opencode");
    const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;
    const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" }).prepared._opencodeSession;

    expect(first).toBe(second);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("isolates different conversations and tools", () => {
    const executor = getExecutor("opencode");
    const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession;
    const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession;
    const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared._opencodeSession;
    const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared._opencodeSession;

    expect(convA).not.toBe(convB);
    expect(toolClaude).not.toBe(toolCodex);
  });

  it("adds the valid session header to fetch requests", async () => {
    const executor = getExecutor("opencode");
    const credentials = makeCredentials();
    const result = await executor.execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      stream: false,
      credentials,
      providerSessionId: "conversation-fetch-test",
      clientTool: "claude",
    });

    expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(result.headers["x-opencode-session"]);
    expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public");
    expect(credentials).not.toHaveProperty("_opencodeSession");
  });

  it("falls back to a valid generated session in buildHeaders when called standalone", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({});

    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["Authorization"]).toBe("Bearer public");
  });
  it("handles null or undefined body gracefully in transformRequest", () => {
    const executor = getExecutor("opencode");
    expect(() => executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {})).not.toThrow();
    expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow();
  });
});

describe("OpenCode Free User-Agent Validation", () => {
  it("defaults User-Agent to opencode/1.18.31 for non-opencode downstream clients", () => {
    const executor = getExecutor("opencode");
    const headersNoUa = executor.buildHeaders({});
    expect(headersNoUa["User-Agent"]).toBe("opencode/1.18.31");

    const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } });
    expect(headersClaude["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("replaces bare opencode with versioned opencode/1.18.31 to prevent 403 FreeTierError", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode" } });
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("upgrades outdated opencode versions (< 1.17) to prevent 426 Upgrade Required", () => {
    const executor = getExecutor("opencode");
    const headers = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.15.0" } });
    expect(headers["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("preserves valid opencode versions (>= 1.17)", () => {
    const executor = getExecutor("opencode");
    const headers118 = executor.buildHeaders({
      rawHeaders: { "user-agent": "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14" },
    });
    expect(headers118["User-Agent"]).toBe("opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14");

    const headersFuture = executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.19.0" } });
    expect(headersFuture["User-Agent"]).toBe("opencode/1.19.0");
  });
});

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
  function anonymousCredentials(auth) {
    return makeCredentials({ connectionId: undefined, rawHeaders: { authorization: `Bearer ${auth}` } });
  }

  it("reuses one stable upstream session instead of minting a new one per request", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });
    const second = executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials("stable-key-1"),
      providerSessionId: null,
      clientTool: "claude",
    });

    expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE);
    expect(second._opencodeSession).toBe(first._opencodeSession);
  });

  it("isolates stable sessions by downstream identity", () => {
    const executor = getExecutor("opencode");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const forKey = (auth) => executor.prepareRequestCredentials({
      body,
      credentials: anonymousCredentials(auth),
      providerSessionId: null,
      clientTool: "claude",
    })._opencodeSession;

    expect(forKey("user-A")).not.toBe(forKey("user-B"));
    expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE);
  });

  it("publishes candidate sessions only for strict Public proxy 8900", () => {
    const makePublic = (pool, port = "8900", strictProxy = true) => ({
      id: "noauth",
      connectionId: "noauth",
      connectionName: "Public",
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: `http://proxy.example:${port}`,
        connectionProxyPoolId: pool,
        strictProxy,
      },
      rawHeaders: {},
    });
    const target = makePublic("pool-8900");
    const otherPool = makePublic("pool-other", "8900");
    expect(supportsPublicSessionRefresh(target)).toBe(true);
    expect(supportsPublicSessionRefresh(makePublic("pool-http", "8901"))).toBe(false);
    expect(supportsPublicSessionRefresh({ ...target, providerSpecificData: { ...target.providerSpecificData, connectionProxyUrl: "ftp://proxy.example:8900" } })).toBe(false);
    expect(supportsPublicSessionRefresh({ ...target, providerSpecificData: { ...target.providerSpecificData, connectionProxyUrl: "http://proxy.example:8900/path" } })).toBe(true);
    const candidate = createPublicSessionCandidate(target);
    expect(candidate.sessionId).toMatch(OPENCODE_SESSION_RE);
    expect(activePublicSessionId(target)).toBeNull();
    expect(publishPublicSessionCandidate(candidate)).toBe(true);
    expect(activePublicSessionId(target)).toBe(candidate.sessionId);
    expect(activePublicSessionId(otherPool)).toBeNull();
    expect(createPublicSessionCandidate(makePublic("pool-insecure", "8900", false))).toBeNull();
    expect(createPublicSessionCandidate({ ...target, connectionId: "paid-account" })).toBeNull();
  });

  it("uses the published Public session ahead of stale native sessions", () => {
    const executor = getExecutor("opencode");
    const credentials = {
      id: "noauth",
      connectionId: "noauth",
      connectionName: "Public",
      providerSpecificData: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.example:8900",
        connectionProxyPoolId: "pool-override",
        strictProxy: true,
      },
      rawHeaders: {},
    };
    const candidate = createPublicSessionCandidate(credentials);
    publishPublicSessionCandidate(candidate);
    const normal = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials,
      providerSessionId: "chat-core-seed",
      clientTool: "claude",
    });
    expect(normal._opencodeSession).toBe(candidate.sessionId);

    const nativeSession = generateSessionId();
    const native = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: { ...credentials, rawHeaders: { "x-opencode-session": nativeSession } },
      providerSessionId: "chat-core-seed",
      clientTool: "claude",
    });
    expect(native._opencodeSession).toBe(candidate.sessionId);

    const probe = executor.prepareRequestCredentials({
      body: { messages: [{ role: "user", content: "hello" }] },
      credentials: { ...credentials, rawHeaders: { "x-opencode-session": candidate.sessionId } },
      providerSessionId: candidate.sessionId,
      clientTool: "opencode",
    });
    expect(probe._opencodeSession).toBe(candidate.sessionId);
  });

  it("exposes the stable session helper directly", () => {
    const first = stableSessionId({ connectionId: "direct-conn" });
    expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first);
    expect(first).toMatch(OPENCODE_SESSION_RE);
  });

  it("derives deterministic, canonical request ids per message", () => {
    const session = stableSessionId({ connectionId: "req-conn" });
    const body = { messages: [{ role: "user", content: "ping" }] };
    const first = deriveRequestId(session, body);
    expect(first).toMatch(OPENCODE_REQUEST_RE);
    expect(deriveRequestId(session, body)).toBe(first);
    expect(
      deriveRequestId(session, { messages: [{ role: "user", content: "a different question" }] }),
    ).not.toBe(first);
  });

  it("preserves a valid downstream x-opencode-request header", () => {
    const executor = getExecutor("opencode");
    const validReq = "msg_0ae8d9cd3001swxaFbM248jcIF";
    const { prepared } = prepare(executor, {
      credentials: makeCredentials({ rawHeaders: { "x-opencode-request": validReq } }),
    });
    expect(prepared._opencodeRequest).toBe(validReq);
  });

  it("keeps the standalone buildHeaders session stable across calls", () => {
    const executor = getExecutor("opencode");
    const first = executor.buildHeaders({})["x-opencode-session"];
    const second = executor.buildHeaders({})["x-opencode-session"];
    expect(first).toMatch(OPENCODE_SESSION_RE);
    expect(second).toBe(first);
  });

  it("applies the full lowercase free-tier fingerprint quartet", () => {
  const executor = getExecutor("opencode");

  const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
  });
  expect(chatNoTools.stream).toBe(true);
  expect(chatNoTools.tool_choice).toBe("none");
  expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual([
    "_noop", "bash", "glob", "grep", "read",
  ]);

  const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "Bash", description: "Claude Code tool" } },
      { type: "function", function: { name: "Glob", description: "Claude Code tool" } },
      { type: "function", function: { name: "Grep", description: "Claude Code tool" } },
      { type: "function", function: { name: "Read", description: "Claude Code tool" } },
    ],
    tool_choice: "auto",
  });
  expect(chatWithTools.tool_choice).toBe("auto");
  expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual([
    "bash", "glob", "grep", "read",
  ]);

  const chatPartial = executor.transformRequest("nemotron-3-ultra-free", {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "bash", description: "existing" } },
      { type: "function", function: { name: "read", description: "existing" } },
    ],
  });
  expect(chatPartial.tools.map((t) => t.function?.name)).toEqual([
    "bash", "read", "glob", "grep",
  ]);
  expect(chatPartial.tools[0].function.description).toBe("existing");
});

  it("cloaks Muse Responses requests even when the client already supplies tools", () => {
    const executor = getExecutor("opencode");
    const transformed = executor.transformRequest("muse-spark-1.3-contributor-free(xhigh)", {
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      tools: [{
        type: "function",
        name: "zcode_search",
        description: "client-provided tool",
        parameters: { type: "object", properties: {} },
      }],
      tool_choice: "auto",
      reasoning_effort: "xhigh",
    }, true, {});

    expect(transformed.stream).toBe(true);
    expect(transformed.reasoning?.effort).toBe("xhigh");
    const names = transformed.tools.map((tool) => tool.name);
    expect(names).toContain("zcode_search");
    expect(names).toContain("bash");
    expect(names).toContain("read");
    expect(names.filter((name) => name === "bash")).toHaveLength(1);
    expect(names.filter((name) => name === "read")).toHaveLength(1);
  });

  it("declares provider-wide forceStream for OpenCode", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    expect(PROVIDERS.opencode?.forceStream).toBe(true);
  });
});
