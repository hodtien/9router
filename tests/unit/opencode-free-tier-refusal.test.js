import { beforeEach, describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));

// ponytail: auth.js pulls in a heavy DB+network chain on import. The predicate
// we want to test only reads its three arguments, so mock every collaborator
// the module touches so ESM collection completes.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: vi.fn(),
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: vi.fn(),
}));
vi.mock("open-sse/services/accountFallback.js", () => ({
  formatRetryAfter: vi.fn(),
  checkFallbackError: vi.fn(),
  isModelLockActive: vi.fn(),
  buildModelLockUpdate: vi.fn(),
  getEarliestModelLockUntil: vi.fn(),
}));
vi.mock("open-sse/config/errorConfig.js", () => ({
  MAX_RATE_LIMIT_COOLDOWN_MS: 60_000,
}));
vi.mock("../../src/shared/constants/providers.js", () => ({
  resolveProviderId: (p) => {
    if (p === "oc" || p === "opencode") return "opencode";
    if (p === "kiro") return "kiro";
    if (p === "github") return "github";
    return p;
  },
  getProviderAlias: vi.fn(),
  FREE_PROVIDERS: {},
}));
vi.mock("../../src/sse/services/antigravityQuota.js", () => ({
  getAntigravityQuotaCache: vi.fn(),
}));
vi.mock("../../src/sse/utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

const { isOpencodeFreeTierRefusal, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

describe("isOpencodeFreeTierRefusal (PR #14011)", () => {
  const text = "OpenCode's free tier can only be used from within OpenCode";

  beforeEach(() => {
    mocks.getProviderConnections.mockReset();
    mocks.updateProviderConnection.mockReset();
  });

  it("matches the opencode 403 free-tier refusal verbatim", () => {
    expect(isOpencodeFreeTierRefusal("opencode", 403, text)).toBe(true);
    expect(
      isOpencodeFreeTierRefusal("opencode", 403, JSON.stringify({ message: text }))
    ).toBe(true);
  });

  it("matches when the alias oc is used (provider id resolves to opencode)", () => {
    expect(isOpencodeFreeTierRefusal("oc", 403, text)).toBe(true);
  });

  it("matches 451 in addition to 403", () => {
    expect(isOpencodeFreeTierRefusal("opencode", 451, text)).toBe(true);
    expect(isOpencodeFreeTierRefusal("opencode", 429, text)).toBe(false);
    expect(isOpencodeFreeTierRefusal("opencode", 500, text)).toBe(false);
  });

  it("does not match other providers", () => {
    expect(isOpencodeFreeTierRefusal("kiro", 403, text)).toBe(false);
    expect(isOpencodeFreeTierRefusal("github", 403, text)).toBe(false);
    expect(isOpencodeFreeTierRefusal(null, 403, text)).toBe(false);
  });

  it("does not match similar 403 messages from other providers (geo-block, user_blocked)", () => {
    expect(isOpencodeFreeTierRefusal("opencode", 403, "User blocked")).toBe(false);
    expect(isOpencodeFreeTierRefusal("opencode", 403, "Request forbidden by region")).toBe(false);
    expect(isOpencodeFreeTierRefusal("opencode", 403, "")).toBe(false);
  });

  it("handles object errorText by JSON.stringifying it (defensive)", () => {
    expect(isOpencodeFreeTierRefusal("opencode", 403, { message: text })).toBe(true);
    expect(isOpencodeFreeTierRefusal("opencode", 403, { error: { code: 403 } })).toBe(false);
  });

  it("matches machine-token and opencode-family variants case-insensitively", () => {
    expect(isOpencodeFreeTierRefusal("opencode-zen", 403, '{"error":{"type":"FreeTierError"}}')).toBe(true);
    expect(isOpencodeFreeTierRefusal("OpenCode-Custom", 451, "FREETIERERROR")).toBe(true);
  });

  it("leaves fingerprint, geo and user_blocked refusals to their own handling", () => {
    expect(isOpencodeFreeTierRefusal("opencode", 403, '{"error_code":1010,"error":{"type":"FreeTierError"}}')).toBe(false);
    expect(isOpencodeFreeTierRefusal("opencode", 403, "FreeTierError: not available in your country")).toBe(false);
    expect(isOpencodeFreeTierRefusal("opencode", 403, "FreeTierError: [user_blocked] egress refused")).toBe(false);
  });

  it("does not rotate or write account state for a request-scoped refusal", async () => {
    const result = await markAccountUnavailable("account-1", 403, text, "opencode-zen", "mimo-v2.5-free");
    expect(result).toEqual({ shouldFallback: false, cooldownMs: 0 });
    expect(mocks.getProviderConnections).not.toHaveBeenCalled();
    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("preserves strictProxy on stored provider credentials", async () => {
    mocks.getProviderConnections.mockResolvedValue([{
      id: "connection-1",
      provider: "opencode",
      providerSpecificData: { proxyPoolId: "pool-1" },
      testStatus: "active",
    }]);
    mocks.getSettings.mockResolvedValue({ providerStrategies: {}, fallbackStrategy: "fill-first" });
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      proxyPoolId: "pool-1",
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.internal:8900",
      connectionNoProxy: "",
      strictProxy: true,
      vercelRelayUrl: "",
    });

    const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
    const credentials = await getProviderCredentials("opencode");

    expect(credentials.providerSpecificData.strictProxy).toBe(true);
  });
});
