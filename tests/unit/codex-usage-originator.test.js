/**
 * Codex usage endpoint (`/backend-api/wham/usage`) must rotate its `originator`
 * suffix per `chatgptAccountId` so the quota probe doesn't fingerprint-collapse
 * 50 connections on one machine.
 *
 * Mirrors the style of `codex-reset-credits.test.js`: mock `proxyAwareFetch`
 * and assert the headers argument passed in.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

vi.mock("open-sse/index.js", () => ({}));

beforeEach(() => {
  mocks.proxyAwareFetch.mockReset();
  // Default to a successful-ish response so the wrapper returns the quota body.
  mocks.proxyAwareFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ rate_limit: { primary_window: { used_percent: 50 } } }),
  });
});

describe("Codex getCodexUsage — per-account originator", () => {
  it("sends the chatgptAccountId-rotated originator when providerSpecificData has chatgptAccountId", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token", { strictProxy: false }, {
      chatgptAccountId: "deada48a-9b73-4d45-bafc-ed37b5c4c44a",
    });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.stringContaining("/wham/usage"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer token",
          "originator": "codex_cli_rs/deada48a",
          "ChatGPT-Account-ID": "deada48a-9b73-4d45-bafc-ed37b5c4c44a",
        }),
      }),
      { strictProxy: false },
    );
  });

  it("prefers workspaceId for both the suffix and the binding header", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token", null, {
      workspaceId: "ws-deadbeef-0000",
      chatgptAccountId: "account-1111",
    });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "originator": "codex_cli_rs/ws-deadb",
          "ChatGPT-Account-ID": "ws-deadbeef-0000",
        }),
      }),
      null,
    );
  });

  it("omits the originator and account header when no account id is available", async () => {
    const { getCodexUsage } = await import("../../open-sse/services/usage/codex.js");
    await getCodexUsage("token", null, null);
    const callHeaders = mocks.proxyAwareFetch.mock.calls[0][1].headers;
    expect(callHeaders.originator).toBeUndefined();
    expect(callHeaders["ChatGPT-Account-ID"]).toBeUndefined();
    expect(callHeaders.Authorization).toBe("Bearer token");
  });
});
