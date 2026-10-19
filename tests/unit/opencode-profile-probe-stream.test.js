import { describe, expect, it } from "vitest";
import { convertResponsesStreamToJson } from "../../open-sse/transformer/streamToJsonConverter.js";

function streamOf(value) {
  return new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function cancellableStream(value, { pull = null } = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      if (value) controller.enqueue(new TextEncoder().encode(value));
    },
    pull(controller) {
      if (pull) return pull(controller);
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  return { stream, wasCancelled: () => cancelled };
}

const completedEvent = (output = [{
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text: "READY" }],
}]) => `event: response.completed\ndata: ${JSON.stringify({
  type: "response.completed",
  response: { status: "completed", output },
})}\n\n`;

describe("bounded OpenCode profile Responses probe stream", () => {
  it("accepts a completed response with assistant text", async () => {
    const response = await convertResponsesStreamToJson(streamOf(completedEvent()), { maxBytes: 1024 });
    expect(response.status).toBe("completed");
    expect(response.output[0].content[0].text).toBe("READY");
  });

  it("does not mark an empty stream complete", async () => {
    const response = await convertResponsesStreamToJson(streamOf(""));
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
  });

  it("rejects a completed event with a non-completed status", async () => {
    const response = await convertResponsesStreamToJson(streamOf(
      `event: response.done\ndata: ${JSON.stringify({ type: "response.done", response: { status: "incomplete", output: [] } })}\n\n`,
    ));
    expect(response.status).toBe("incomplete");
  });

  it("rejects an explicit failed response event", async () => {
    const response = await convertResponsesStreamToJson(streamOf(
      `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}\n\n`,
    ));
    expect(response.status).toBe("failed");
  });

  it("fails closed when a probe stream exceeds its byte budget", async () => {
    await expect(convertResponsesStreamToJson(streamOf(completedEvent()), { maxBytes: 8 })).rejects.toThrow("exceeded limit");
  });

  it("fails closed when an SSE error event is malformed", async () => {
    const response = await convertResponsesStreamToJson(streamOf("event: error\ndata: not-json\n\n"));
    expect(response.status).toBe("failed");
  });

  it("does not return an earlier success after a later failure", async () => {
    const events = `${completedEvent()}event: response.failed\ndata: ${JSON.stringify({ response: { status: "failed" } })}\n\n`;
    const response = await convertResponsesStreamToJson(streamOf(events));
    expect(response.status).toBe("failed");
    expect(response.output).toEqual([]);
  });

  it("does not return success after an incomplete response.done", async () => {
    const events = `${completedEvent()}event: response.done\ndata: ${JSON.stringify({ response: { status: "incomplete", output: [] } })}\n\n`;
    const response = await convertResponsesStreamToJson(streamOf(events));
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
  });

  it("does not return success after a malformed error event", async () => {
    const events = `${completedEvent()}event: error\ndata: malformed\n\n`;
    const response = await convertResponsesStreamToJson(streamOf(events));
    expect(response.status).toBe("failed");
    expect(response.output).toEqual([]);
  });

  it("does not accept an empty response.completed output", async () => {
    const response = await convertResponsesStreamToJson(streamOf(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [] } })}\n\n`,
    ));
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
  });

  it("does not accept malformed completed output", async () => {
    const response = await convertResponsesStreamToJson(streamOf(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [null] } })}\n\n`,
    ));
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
  });

  it("does not accept a response.completed event without output", async () => {
    const response = await convertResponsesStreamToJson(streamOf(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
    ));
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
  });

  it("lets accumulated output items complete an empty terminal output", async () => {
    const events = [
      `event: response.output_item.done\ndata: ${JSON.stringify({ output_index: 0, item: { type: "message", role: "assistant", content: [] } })}`,
      `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", output: [] } })}`,
    ].join("\n\n");
    const response = await convertResponsesStreamToJson(streamOf(`${events}\n\n`));
    expect(response.status).toBe("completed");
    expect(response.output).toHaveLength(1);
  });

  it("cancels the reader when the stream exceeds its byte budget", async () => {
    const fixture = cancellableStream(completedEvent(), { pull: () => new Promise(() => {}) });
    await expect(convertResponsesStreamToJson(fixture.stream, { maxBytes: 8 })).rejects.toThrow("exceeded limit");
    expect(fixture.wasCancelled()).toBe(true);
  });

  it("cancels and rejects when the stream times out", async () => {
    const fixture = cancellableStream(null, { pull: () => new Promise(() => {}) });
    await expect(convertResponsesStreamToJson(fixture.stream, { timeoutMs: 5 })).rejects.toThrow("timed out");
    expect(fixture.wasCancelled()).toBe(true);
  });
});
