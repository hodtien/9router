import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  getOpenCodeProfileStatus: vi.fn(),
  markOpenCodeProfileProbeFailed: vi.fn(),
  refreshOpenCodeProfile: vi.fn(),
  createPublicSessionCandidate: vi.fn(),
  publishPublicSessionCandidate: vi.fn(),
  generateRequestId: vi.fn(),
  getExecutor: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
}));
vi.mock("@/lib/opencodeProfile.js", () => ({
  getOpenCodeProfileStatus: mocks.getOpenCodeProfileStatus,
  markOpenCodeProfileProbeFailed: mocks.markOpenCodeProfileProbeFailed,
  refreshOpenCodeProfile: mocks.refreshOpenCodeProfile,
}));
vi.mock("open-sse/executors/index.js", () => ({ getExecutor: mocks.getExecutor }));
vi.mock("open-sse/executors/opencode.js", () => ({
  createPublicSessionCandidate: mocks.createPublicSessionCandidate,
  publishPublicSessionCandidate: mocks.publishPublicSessionCandidate,
  generateRequestId: mocks.generateRequestId,
}));

const { GET, POST } = await import("../../src/app/api/cli-tools/opencode-profile/route.js");

const credentials = {
  id: "noauth",
  connectionId: "noauth",
  connectionName: "Public",
  providerSpecificData: {
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://user:secret@proxy.example:8900",
    connectionNoProxy: "",
    connectionProxyPoolId: "pool-1",
    strictProxy: true,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviderCredentials.mockResolvedValue(credentials);
  mocks.getOpenCodeProfileStatus.mockResolvedValue({
    state: "unsupported",
    proxy: "configured",
    handoff: "unverified",
  });
  mocks.refreshOpenCodeProfile.mockResolvedValue({
    state: "unsupported",
    proxy: "configured",
    handoff: "unverified",
  });
  mocks.createPublicSessionCandidate.mockReturnValue({ key: "public-key", sessionId: "ses_0123456789abABCDEFGHIJKLMNOP" });
  mocks.generateRequestId.mockReturnValue("msg_0123456789abABCDEFGHIJKLMNOP");
  mocks.publishPublicSessionCandidate.mockReturnValue(true);
  mocks.getExecutor.mockReturnValue({ execute: vi.fn() });
});

describe("OpenCode profile route", () => {
  it("resolves proxy settings server-side and returns sanitized status", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledWith("opencode");
    expect(mocks.getOpenCodeProfileStatus).toHaveBeenCalledWith({
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://user:secret@proxy.example:8900",
        connectionNoProxy: "",
        connectionProxyPoolId: "pool-1",
        connectionId: "noauth",
        connectionName: "Public",
        strictProxy: true,
        vercelRelayUrl: "",
      },
    });
    expect(body.state).toBe("unsupported");
    expect(body).not.toHaveProperty("proxyUrl");
  });

  it("fails closed when the gateway does not manage a real OpenCode CLI profile", async () => {
    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(501);
    expect(body.state).toBe("unsupported");
    expect(body.handoff).toBe("unverified");
    expect(mocks.refreshOpenCodeProfile).toHaveBeenCalledWith({ force: false, proxyOptions: {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://user:secret@proxy.example:8900",
      connectionNoProxy: "",
      connectionProxyPoolId: "pool-1",
      connectionId: "noauth",
      connectionName: "Public",
      strictProxy: true,
      vercelRelayUrl: "",
    } });
  });

  it("propagates a non-Public credential identity so the profile guard rejects it", async () => {
    mocks.getProviderCredentials.mockResolvedValueOnce({
      ...credentials,
      id: "conn-paid-1",
      connectionId: "conn-paid-1",
      connectionName: "Work",
    });

    await GET();

    expect(mocks.getOpenCodeProfileStatus).toHaveBeenCalledWith({
      proxyOptions: expect.objectContaining({
        connectionId: "conn-paid-1",
        connectionName: "Work",
      }),
    });
  });

  it("does not return successful refresh when the status is cooldown", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({
      state: "cooldown",
      proxy: "configured",
      handoff: "unverified",
    });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(body.state).toBe("cooldown");
    expect(body.handoff).toBe("unverified");
  });

  it("maps executor spawn failures to transport-spawn without publishing", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    const error = new Error("hidden transport detail");
    error.code = "OPENCODE_TRANSPORT_SPAWN";
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockRejectedValue(error) });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ handoff: "unverified", probeStage: "transport-spawn" });
    expect(JSON.stringify(body)).not.toContain("hidden transport detail");
    expect(mocks.publishPublicSessionCandidate).not.toHaveBeenCalled();
    expect(mocks.markOpenCodeProfileProbeFailed).toHaveBeenCalledWith({ proxyOptions: expect.any(Object) });
  });

  it("maps executor metadata failures to transport-metadata without publishing", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    const error = new Error("malformed metadata detail");
    error.code = "OPENCODE_TRANSPORT_METADATA";
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockRejectedValue(error) });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ handoff: "unverified", probeStage: "transport-metadata" });
    expect(JSON.stringify(body)).not.toContain("malformed metadata detail");
    expect(mocks.publishPublicSessionCandidate).not.toHaveBeenCalled();
  });

  it("falls back to safe transport-metadata for an unexpected executor error code", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    const error = new Error("unexpected private transport detail");
    error.code = "UNEXPECTED_INTERNAL_CODE";
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockRejectedValue(error) });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ handoff: "unverified", probeStage: "transport-metadata" });
    expect(JSON.stringify(body)).not.toContain("UNEXPECTED_INTERNAL_CODE");
    expect(JSON.stringify(body)).not.toContain("unexpected private transport detail");
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["state", "proxy", "handoff", "probeStage"]));
    expect(Object.keys(body)).not.toContain("code");
    expect(Object.keys(body)).not.toContain("message");
  });

  it("classifies a non-success executor response as http-status", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockResolvedValue({
      response: new Response(JSON.stringify({ type: "FreeUsageLimitError" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    }) });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      handoff: "unverified",
      probeStage: "http-status",
      upstreamClass: "free-tier-rate-limit",
    });
  });

  it("maps a response without valid metadata to transport-metadata", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockResolvedValue({ response: {} }) });

    const response = await POST();
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ handoff: "unverified", probeStage: "transport-metadata" });
  });

  it("rejects an incomplete JSON response and persists failed state", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockResolvedValue({
      response: new Response(JSON.stringify({ status: "completed", output: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    }) });

    const response = await POST();
    expect(response.status).toBe(502);
    expect(mocks.publishPublicSessionCandidate).not.toHaveBeenCalled();
    expect(mocks.markOpenCodeProfileProbeFailed).toHaveBeenCalled();
  });

  it("rejects an oversized JSON response before parsing", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockResolvedValue({
      response: new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(1024 * 1024) }] }] }), { status: 200, headers: { "content-type": "application/json" } }),
    }) });

    const response = await POST();
    expect(response.status).toBe(502);
    expect(mocks.publishPublicSessionCandidate).not.toHaveBeenCalled();
    expect(mocks.markOpenCodeProfileProbeFailed).toHaveBeenCalled();
  });

  it("rejects a slow JSON response after the bounded timeout", async () => {
    mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
    const stream = new ReadableStream({ pull() { return new Promise(() => {}); } });
    mocks.getExecutor.mockReturnValue({ execute: vi.fn().mockResolvedValue({
      response: new Response(stream, { status: 200, headers: { "content-type": "application/json" } }),
    }) });

    const pending = POST();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 30_050));
    const response = await pending;
    expect(response.status).toBe(502);
    expect(mocks.publishPublicSessionCandidate).not.toHaveBeenCalled();
    expect(mocks.markOpenCodeProfileProbeFailed).toHaveBeenCalled();
  }, 35_000);

  it("resets, probes one candidate, then publishes it", async () => {
    const order = [];
    mocks.refreshOpenCodeProfile.mockImplementation(async () => {
      order.push("reset-and-preflight");
      return { state: "ready", proxy: "configured", handoff: "unverified" };
    });
    mocks.createPublicSessionCandidate.mockImplementation(() => {
      order.push("candidate");
      return { key: "public-key", sessionId: "ses_0123456789abABCDEFGHIJKLMNOP" };
    });
    const execute = vi.fn(async (args) => {
      order.push("probe");
      expect(args.providerSessionId).toBe("ses_0123456789abABCDEFGHIJKLMNOP");
      expect(args.credentials.rawHeaders["x-opencode-session"]).toBe("ses_0123456789abABCDEFGHIJKLMNOP");
      expect(args.credentials.rawHeaders["x-opencode-request"]).toBe("msg_0123456789abABCDEFGHIJKLMNOP");
      expect(args.credentials.rawHeaders["x-session-id"]).toBeUndefined();
      expect(args.proxyOptions.connectionProxyUrl).toBe("http://user:secret@proxy.example:8900");
      return { response: new Response(JSON.stringify({ id: "resp-1", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "pong" }] }] }), { status: 200, headers: { "content-type": "application/json" } }) };
    });
    mocks.getExecutor.mockReturnValue({ execute });
    mocks.publishPublicSessionCandidate.mockImplementation(() => {
      order.push("publish");
      return true;
    });

    const response = await POST(new Request("http://localhost/api/cli-tools/opencode-profile", {
      method: "POST",
      body: JSON.stringify({ proxyUrl: "http://attacker.example:1", session: "attacker-session" }),
    }));
    const body = await response.json();

    expect(order).toEqual(["reset-and-preflight", "candidate", "probe", "publish"]);
    expect(response.status).toBe(200);
    expect(body.handoff).toBe("verified");
    expect(JSON.stringify(body)).not.toContain("attacker.example");
    expect(JSON.stringify(body)).not.toContain("ses_");
  });
});
