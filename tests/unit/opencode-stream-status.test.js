import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: mocks.spawn,
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

function makeChild(status, body) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  child.stdin = {
    end: vi.fn(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(`${JSON.stringify({ status, headers: { "content-type": "application/json" } })}\n${body}`));
        child.emit("exit", 0);
      });
    }),
  };
  return child;
}

describe("OpenCode streaming transport status", () => {
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
});
