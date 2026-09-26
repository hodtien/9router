import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetToolObservationForTests, getObservedToolNames } from "../../open-sse/executors/opencodeToolObservation.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

function makeChild(status, body, headers = { "content-type": "application/json" }, inputs = []) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  child.stdin = {
    end: vi.fn((input) => {
      inputs.push(JSON.parse(input));
      queueMicrotask(() => {
        const streaming = JSON.parse(input).stream;
        child.stdout.emit("data", Buffer.from(streaming
          ? `${JSON.stringify({ status, headers })}\n${body}`
          : JSON.stringify({ status, headers, body })));
        child.emit("exit", 0);
        child.emit("close", 0);
      });
    }),
  };
  return child;
}

describe("OpenCode streaming transport status", () => {
  beforeEach(() => {
    _resetToolObservationForTests();
    mocks.spawn.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENCODE_FETCHER_PATH;
  });

  it("waits for Bun metadata before constructing the upstream Response", async () => {
    const upstreamBody = JSON.stringify({
      type: "FreeTierError",
      message: "OpenCode's free tier can only be used from within OpenCode",
    });
    mocks.spawn.mockReturnValue(makeChild(403, upstreamBody));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;

    const result = await new OpenCodeExecutor().execute({
      model: "mimo-v2.5-free",
      body: { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { connectionId: "noauth", rawHeaders: {} },
    });

    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toContain("FreeTierError");
  });

  it("streams a gated Chat request upstream and rebuilds JSON for a JSON caller", async () => {
    const inputs = [];
    const sse = [
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"mimo-v2.5-free","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"mimo-v2.5-free","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    mocks.spawn.mockReturnValue(makeChild(200, sse, { "content-type": "text/event-stream" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;

    const result = await new OpenCodeExecutor().execute({
      model: "mimo-v2.5-free",
      body: { model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { connectionId: "noauth", rawHeaders: {} },
      providerSessionId: "conversation-a",
    });

    expect(inputs[0].stream).toBe(true);
    expect(JSON.parse(inputs[0].body)).toMatchObject({ stream: true });
    expect(inputs[0].headers.Accept).toBe("text/event-stream");
    expect(result.response.headers.get("content-type")).toContain("application/json");
    expect(await result.response.json()).toMatchObject({
      object: "chat.completion",
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
    });
  });

  it("drains stdout arriving after process exit before closing the stream", async () => {
    const child = makeChild(200, "");
    child.stdin.end = vi.fn(() => queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"status":200,"headers":{"content-type":"text/event-stream"}}\nfirst'));
      child.emit("exit", 0);
      child.stdout.emit("data", Buffer.from("last"));
      child.emit("close", 0);
    }));
    mocks.spawn.mockReturnValue(child);
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "mimo-v2.5-free", body: { messages: [] }, stream: true, credentials: {},
    });
    expect(await result.response.text()).toBe("firstlast");
  });

  it("cancels the child without throwing when more data or exit arrives", async () => {
    const child = makeChild(200, "", { "content-type": "text/event-stream" });
    child.stdin.end = vi.fn(() => queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from('{"status":200,"headers":{"content-type":"text/event-stream"}}\n'));
    }));
    mocks.spawn.mockReturnValue(child);
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "mimo-v2.5-free", body: { messages: [] }, stream: true, credentials: {},
    });
    await result.response.body.cancel();
    expect(() => child.stdout.emit("data", Buffer.from("late data"))).not.toThrow();
    expect(() => child.emit("exit", 0)).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("honors a streaming caller outside the gated model catalog", async () => {
    const inputs = [];
    mocks.spawn.mockReturnValue(makeChild(200, "data: hello\n\n", { "content-type": "text/event-stream" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "big-pickle", body: { messages: [{ role: "user", content: "hi" }] },
      stream: true, credentials: {},
    });
    expect(inputs[0].stream).toBe(true);
    expect(JSON.parse(inputs[0].body).stream).toBe(true);
    expect(await result.response.text()).toBe("data: hello\n\n");
  });

  it("rejects instead of Node-falling-back when Bun exits non-zero under strict proxy", async () => {
    // A premium (non-gated) model with stream:false keeps upstreamStream false,
    // so a non-zero Bun exit reaches the tryNodeFallback branch — the only path
    // where the strict-proxy guard against direct egress matters.
    let spawns = 0;
    mocks.spawn.mockImplementation(() => {
      spawns += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { end: vi.fn(() => queueMicrotask(() => child.emit("close", 1))) };
      return child;
    });
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    process.env.OPENCODE_NODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.mjs", import.meta.url).pathname;

    await expect(new OpenCodeExecutor().execute({
      model: "gpt-5",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: {},
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.internal:8900",
        strictProxy: true,
      },
    })).rejects.toThrow(/strict proxy/i);
    expect(spawns).toBe(1);
  });

  it("does not retry a borrowed-placeholder FreeTier refusal", async () => {
    const inputs = [];
    const refusal = JSON.stringify({ type: "FreeTierError", message: "free tier can only be used within OpenCode" });
    mocks.spawn.mockReturnValue(makeChild(403, refusal, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free", body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials: {},
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(JSON.parse(inputs[0].body).tools.map((tool) => tool.name)).toEqual([
      "_noop", "bash", "glob", "grep", "read",
    ]);
    expect(result.response.status).toBe(403);
  });

  it("does not retry a classified OpenCode 429", async () => {
    const inputs = [];
    const rateLimit = JSON.stringify({ type: "FreeUsageLimitError", message: "rate limit exceeded" });
    mocks.spawn.mockReturnValue(makeChild(429, rateLimit, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true,
      credentials: {},
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(429);
  });

  it("does not retry an invalid-session FreeTier refusal", async () => {
    const inputs = [];
    const refusal = JSON.stringify({ type: "FreeTierError", message: "free tier can only be used within OpenCode" });
    mocks.spawn.mockReturnValue(makeChild(403, refusal, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free", body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials: { rawHeaders: { "x-opencode-session": "invalid-session" } },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(inputs[0].headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  });

  it("does not retry a caller-session FreeTier refusal", async () => {
    const inputs = [];
    const refusal = JSON.stringify({ type: "FreeTierError", message: "free tier can only be used within OpenCode" });
    mocks.spawn.mockReturnValue(makeChild(403, refusal, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free", body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials: { rawHeaders: { "x-opencode-session": "ses_f534dfae8ffeCy4Ee4tLWNygDc" } },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(inputs[0].headers["x-opencode-session"]).toBe("ses_f534dfae8ffeCy4Ee4tLWNygDc");
  });

  it("does not retry a second FreeTier refusal", async () => {
    const inputs = [];
    const refusal = JSON.stringify({ type: "FreeTierError", message: "free tier can only be used within OpenCode" });
    mocks.spawn.mockReturnValue(makeChild(403, refusal, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free", body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials: {},
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(403);
  });

  it("returns a classified OpenCode 429 without refreshing session or request identity", async () => {
    const inputs = [];
    const rateLimit = JSON.stringify({ type: "FreeUsageLimitError", message: "rate limit exceeded" });
    mocks.spawn.mockReturnValue(makeChild(429, rateLimit, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true,
      credentials: {
        rawHeaders: {
          "x-opencode-session": "ses_f534dfae8ffeCy4Ee4tLWNygDc",
          "x-opencode-request": "msg_original",
        },
      },
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(inputs[0].headers["x-opencode-session"]).toBe("ses_f534dfae8ffeCy4Ee4tLWNygDc");
    expect(inputs[0].headers["x-opencode-request"]).not.toBe("msg_original");
    expect(result.response.status).toBe(429);
  });

  it("does not retry a classified OpenCode 429", async () => {
    const inputs = [];
    const rateLimit = JSON.stringify({ type: "FreeUsageLimitError", message: "rate limit exceeded" });
    mocks.spawn.mockReturnValue(makeChild(429, rateLimit, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      stream: true, credentials: {},
    });
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(result.response.status).toBe(429);
  });

  it("preserves caller tools on a classified OpenCode 429", async () => {
    const inputs = [];
    const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
    const rateLimit = JSON.stringify({ type: "FreeUsageLimitError", message: "rate limit exceeded" });
    mocks.spawn.mockReturnValue(makeChild(429, rateLimit, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [tool] },
      stream: true, credentials: {},
    });
    const sentTools = JSON.parse(inputs[0].body).tools;
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(sentTools[0]).toEqual(tool);
    expect(sentTools.slice(1).map((entry) => entry.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(result.response.status).toBe(429);
  });

  it("preserves caller tools, appends the fingerprint quartet and learns only caller names", async () => {
    const inputs = [];
    const tool = { type: "function", name: "lookup", parameters: { type: "object", properties: {} } };
    const children = [makeChild(200, "data: ok\\n\\n", { "content-type": "text/event-stream" }, inputs)];
    mocks.spawn.mockImplementation(() => children.shift());
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free", body: { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }], tools: [tool] },
      stream: true, credentials: {},
    });
    const sentTools = JSON.parse(inputs[0].body).tools;
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(sentTools[0]).toEqual(tool);
    expect(sentTools.slice(1).map((entry) => entry.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(await result.response.text()).toBe("data: ok\\n\\n");
    expect(getObservedToolNames("opencode", "muse-spark-1.3-contributor-free")).toEqual(["lookup"]);
  });

  it("learns caller names and borrows the session list without learning placeholders", async () => {
    const executor = new OpenCodeExecutor();
    const inputs = [];
    const model = "mimo-v2.5-free";
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const request = async (session, names, status = 200) => {
      mocks.spawn.mockReturnValue(makeChild(status, "{}", { "content-type": "application/json" }, inputs));
      const result = await executor.execute({
        model,
        body: { messages: [{ role: "user", content: "hi" }], ...(names ? { tools: names.map((name) => ({ type: "function", function: { name } })) } : {}) },
        stream: true,
        credentials: { rawHeaders: { "x-opencode-session": session } },
      });
      await result.response.text();
    };
    await request("a");
    expect(getObservedToolNames("opencode", model)).toBeNull();
    await request("a", ["tool_a"]);
    await request("b", ["tool_b"]);
    await request("a");
    expect(JSON.parse(inputs.at(-1).body).tools.map((tool) => tool.function?.name || tool.name)).toEqual([
      "tool_a", "bash", "glob", "grep", "read",
    ]);
    expect(getObservedToolNames("opencode", model)).toEqual(["tool_b"]);
    await request("a", ["rejected"], 403);
    expect(getObservedToolNames("opencode", model, "a")).toEqual(["tool_a"]);
    for (let i = 0; i < 3; i++) await request("a", null, 403);
    expect(getObservedToolNames("opencode", model, "a")).toBeNull();
    expect(getObservedToolNames("opencode", model)).toEqual(["tool_b"]);
  });

  it("rebuilds a gated Responses stream for a JSON caller", async () => {
    const inputs = [];
    const sse = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","created_at":1}}',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}',
      "",
    ].join("\n\n");
    mocks.spawn.mockReturnValue(makeChild(200, sse, { "content-type": "text/event-stream" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;

    const result = await new OpenCodeExecutor().execute({
      model: "muse-spark-1.3-contributor-free",
      body: { model: "muse-spark-1.3-contributor-free", input: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { connectionId: "noauth", rawHeaders: {} },
      providerSessionId: "conversation-a",
    });

    expect(inputs[0].stream).toBe(true);
    expect(JSON.parse(inputs[0].body)).toMatchObject({ stream: true });
    expect(await result.response.json()).toMatchObject({
      id: "resp-1",
      object: "response",
      status: "completed",
      output: [{ type: "message", role: "assistant" }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  it("preserves non-streaming refusals without a second transport attempt", async () => {
    const inputs = [];
    const refusal = JSON.stringify({ type: "FreeTierError", message: "free tier can only be used within OpenCode" });
    mocks.spawn.mockClear();
    mocks.spawn.mockReturnValue(makeChild(403, refusal, { "content-type": "application/json" }, inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const result = await new OpenCodeExecutor().execute({
      model: "paid-model", body: { messages: [{ role: "user", content: "hi" }] },
      stream: false, credentials: {},
    });
    expect(result.response.status).toBe(403);
    expect(await result.response.text()).toBe(refusal);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(inputs[0].stream).toBe(false);
    expect(inputs[0].headers.Accept).toBe("*/*");
    expect(JSON.parse(inputs[0].body)).toMatchObject({ stream: false });
    expect(JSON.parse(inputs[0].body)).not.toHaveProperty("tools");
  });
});
