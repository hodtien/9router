import { describe, expect, it } from "vitest";
import {
  formatIncompleteOpenAIResponsesStreamFailure,
} from "../../open-sse/utils/responsesStreamHelpers.js";

function parseFailure(sse) {
  const dataLine = sse
    .split("\n")
    .find((line) => line.startsWith("data:"));
  return JSON.parse(dataLine.slice(5).trim());
}

describe("incomplete Responses stream failure event", () => {
  it("names the provider and model that cut the stream short", () => {
    const event = parseFailure(
      formatIncompleteOpenAIResponsesStreamFailure({ provider: "openrouter", model: "deepseek/deepseek-v4.1-flash" }),
    );

    expect(event.response.error.message).toContain("openrouter");
    expect(event.response.error.message).toContain("deepseek/deepseek-v4.1-flash");
  });

  it("keeps the machine-readable code and failed status", () => {
    const event = parseFailure(
      formatIncompleteOpenAIResponsesStreamFailure({ provider: "kilocode", model: "mimo-v2.6-flash-free" }),
    );

    expect(event.type).toBe("response.failed");
    expect(event.response.status).toBe("failed");
    expect(event.response.error.code).toBe("stream_disconnected");
    expect(event.response.error.type).toBe("stream_error");
  });

  it("still emits a terminal event when provider context is unavailable", () => {
    const event = parseFailure(formatIncompleteOpenAIResponsesStreamFailure());

    expect(event.type).toBe("response.failed");
    expect(event.response.status).toBe("failed");
    expect(event.response.error.message).toContain("response.completed");
  });
});