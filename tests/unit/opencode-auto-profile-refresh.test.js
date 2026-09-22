import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
  handleChatCore: vi.fn(),
  checkAndRefreshToken: vi.fn(),
  refreshOpenCodeProfile: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(),
}));
vi.mock("open-sse/executors/opencodeGeoBlock.js", () => ({
  isOpencodeFreeTierRateLimitForProvider: vi.fn((provider, status, bodyText) =>
    provider === "opencode" && status === 429 && String(bodyText).includes("FreeUsageLimitError")),
}));
vi.mock("@/lib/opencodeProfile.js", () => ({
  refreshOpenCodeProfile: mocks.refreshOpenCodeProfile,
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("../services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://headroom.test" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: vi.fn() }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/error.js", () => ({
  errorResponse: vi.fn((status, message) => new Response(JSON.stringify({ error: { message } }), { status })),
  unavailableResponse: vi.fn((status, message) => new Response(JSON.stringify({ error: { message } }), { status })),
}));
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  handleFusionChat: vi.fn(),
  detectRequiredCapabilities: vi.fn(() => new Set()),
}));
vi.mock("open-sse/services/capacityAdapter.js", () => ({
  augmentModelsWithCapacityAdapter: vi.fn((models) => models),
  withCapacityAdapterStripping: vi.fn((handler) => handler),
  getActiveAdapterStrategy: vi.fn(),
}));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: vi.fn(() => null) }));
vi.mock("open-sse/config/runtimeConfig.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    HTTP_STATUS: {
      ...actual.HTTP_STATUS,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      NOT_FOUND: 404,
      SERVICE_UNAVAILABLE: 503,
      BAD_GATEWAY: 502,
    },
  };
});
vi.mock("open-sse/translator/formats.js", () => ({ detectFormatByEndpoint: vi.fn(() => "openai") }));
vi.mock("open-sse/utils/earlySse.js", () => ({
  clientWantsStream: vi.fn(() => false),
  createKeepaliveSseResponse: vi.fn(),
}));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  maskKey: vi.fn(() => "masked"),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: mocks.checkAndRefreshToken,
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: vi.fn() }));
vi.mock("@/shared/utils/modelDiagnosticBypass", () => ({
  hasDiagnosticModelTestBypass: vi.fn(async () => false),
  CLI_TOKEN_HEADER: "x-cli-token",
  MODEL_WHITELIST_BYPASS_HEADER: "x-model-whitelist-bypass",
  MODEL_WHITELIST_BYPASS_NONCE_HEADER: "x-model-whitelist-bypass-nonce",
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const proxyCredentials = {
  connectionId: "noauth",
  connectionName: "Public",
  providerSpecificData: {
    connectionProxyEnabled: true,
    connectionProxyUrl: "http://proxy.internal:8900",
    connectionNoProxy: "",
    connectionProxyPoolId: "pool-1",
    strictProxy: true,
    vercelRelayUrl: "",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSettings.mockResolvedValue({ requireApiKey: false, providerStrategies: {} });
  mocks.getComboModels.mockResolvedValue(null);
  mocks.getModelInfo.mockResolvedValue({ provider: "opencode", model: "muse-spark-1.3-contributor-free" });
  mocks.getProviderCredentials.mockResolvedValue(proxyCredentials);
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false, cooldownMs: 0 });
  mocks.checkAndRefreshToken.mockImplementation(async (_provider, credentials) => credentials);
  mocks.refreshOpenCodeProfile.mockResolvedValue({ state: "ready", proxy: "configured", handoff: "unverified" });
  mocks.handleChatCore.mockImplementation(async ({ onProviderError }) => {
    await onProviderError?.({
      provider: "opencode",
      model: "muse-spark-1.3-contributor-free",
      status: 429,
      bodyText: JSON.stringify({ type: "FreeUsageLimitError" }),
      message: "rate limit exceeded",
    });
    return {
      success: false,
      status: 429,
      error: "FreeUsageLimitError",
      response: new Response(JSON.stringify({ type: "FreeUsageLimitError" }), { status: 429 }),
    };
  });
});

describe("OpenCode automatic profile refresh", () => {
  async function run429({ provider = "opencode", model = "muse-spark-1.3-contributor-free", bodyText = JSON.stringify({ type: "FreeUsageLimitError" }) } = {}) {
    mocks.getModelInfo.mockResolvedValueOnce({ provider, model });
    mocks.handleChatCore.mockImplementationOnce(async ({ onProviderError }) => {
      await onProviderError?.({ provider, model, status: 429, bodyText, message: "rate limit exceeded" });
      return {
        success: false,
        status: 429,
        error: "rate limit exceeded",
        response: new Response(bodyText, { status: 429 }),
      };
    });
    return handleChat(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `${provider}/${model}`, messages: [{ role: "user", content: "hello" }], stream: false }),
    }));
  }

  it("refreshes the effective strict proxy profile without rotating or retrying the request", async () => {
    const response = await run429();

    expect(response.status).toBe(429);
    expect(mocks.refreshOpenCodeProfile).toHaveBeenCalledWith({
      proxyOptions: {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.internal:8900",
        connectionNoProxy: "",
        connectionProxyPoolId: "pool-1",
        strictProxy: true,
        vercelRelayUrl: "",
      },
    });
    expect(mocks.handleChatCore).toHaveBeenCalledOnce();
    expect(mocks.getProviderCredentials).toHaveBeenCalledOnce();
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    ["premium OpenCode", "opencode", "gpt-5", JSON.stringify({ type: "FreeUsageLimitError" })],
    ["Union Alpha", "opencode", "union-alpha", JSON.stringify({ type: "FreeUsageLimitError" })],
    ["OpenCode Go", "opencode-go", "gpt-5", JSON.stringify({ type: "FreeUsageLimitError" })],
    ["unclassified 429", "opencode", "muse-spark-1.3-contributor-free", JSON.stringify({ type: "RateLimitError" })],
  ])("does not refresh for %s", async (_label, provider, model, bodyText) => {
    const response = await run429({ provider, model, bodyText });

    expect(response.status).toBe(429);
    expect(mocks.refreshOpenCodeProfile).not.toHaveBeenCalled();
  });
});
