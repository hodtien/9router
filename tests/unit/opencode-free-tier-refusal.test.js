import { describe, it, expect, vi } from "vitest";

// ponytail: auth.js pulls in a heavy DB+network chain on import. The predicate
// we want to test only reads its three arguments, so mock every collaborator
// the module touches so ESM collection completes.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
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

const { isOpencodeFreeTierRefusal } = await import("../../src/sse/services/auth.js");

describe("isOpencodeFreeTierRefusal (PR #14011)", () => {
  const text = "OpenCode's free tier can only be used from within OpenCode";

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
});
