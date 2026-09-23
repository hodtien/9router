import { afterEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

afterEach(() => {
  fetchMock.mockReset();
});

describe("OpenCode strict proxy transport", () => {
  it("does not fall back to direct fetch when strict proxy has no URL", async () => {
    await expect(proxyAwareFetch("https://opencode.ai/zen/v1/responses", {
      method: "POST",
      body: "{}",
    }, {
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      strictProxy: true,
    })).rejects.toThrow(/proxy required/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
