import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  getOpenCodeProfileStatus: vi.fn(),
  refreshOpenCodeProfile: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
}));
vi.mock("@/lib/opencodeProfile.js", () => ({
  getOpenCodeProfileStatus: mocks.getOpenCodeProfileStatus,
  refreshOpenCodeProfile: mocks.refreshOpenCodeProfile,
}));

const { GET, POST } = await import("../../src/app/api/cli-tools/opencode-profile/route.js");

const credentials = {
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
    state: "ready",
    proxy: "configured",
    handoff: "unverified",
  });
  mocks.refreshOpenCodeProfile.mockResolvedValue({
    state: "ready",
    proxy: "configured",
    handoff: "unverified",
  });
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
        strictProxy: true,
        vercelRelayUrl: "",
      },
    });
    expect(body).not.toHaveProperty("proxyUrl");
    expect(body.handoff).toBe("unverified");
  });

  it("does not accept request input when refreshing the profile", async () => {
    const response = await POST(new Request("http://localhost/api/cli-tools/opencode-profile", {
      method: "POST",
      body: JSON.stringify({ proxyUrl: "http://attacker.example:1", session: "secret" }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.refreshOpenCodeProfile).toHaveBeenCalledWith({
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://user:secret@proxy.example:8900",
        connectionNoProxy: "",
        connectionProxyPoolId: "pool-1",
        strictProxy: true,
        vercelRelayUrl: "",
      },
    });
    expect(JSON.stringify(await response.json())).not.toContain("attacker.example");
  });
});
