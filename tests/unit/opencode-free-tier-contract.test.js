import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyFreeTierRequestContract,
  configuredPlaceholderToolNames,
  noteFreeTierOutcome,
  prepareFreeTierRequest,
  rebuildJsonFromForcedStream,
  requiresFreeTierRequestContract,
} from "../../open-sse/executors/opencodeFreeTierContract.js";
import {
  _resetToolObservationForTests,
  getObservedToolNames,
} from "../../open-sse/executors/opencodeToolObservation.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { getModelTargetFormat } from "../../open-sse/config/providerModels.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const chatBody = () => ({ model: "mimo-v2.5-free", messages: [{ role: "user", content: "hi" }] });

beforeEach(() => {
  _resetToolObservationForTests();
  delete process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT;
  delete process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS;
});
afterEach(() => {
  delete process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT;
  delete process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS;
});

describe("OpenCode free-tier request contract", () => {
  it("gates Zen free models only and supports the body opt-out", () => {
    expect(requiresFreeTierRequestContract("zen", "opencode", "mimo-v2.5-free")).toBe(true);
    expect(requiresFreeTierRequestContract("go", "opencode-go", "mimo-v2.5-free")).toBe(false);
    expect(requiresFreeTierRequestContract("zen", "opencode", "union-alpha")).toBe(false);
    process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT = "off";
    expect(requiresFreeTierRequestContract("zen", "opencode", "mimo-v2.5-free")).toBe(false);
  });

  it("uses one _noop placeholder for chat when no names are known", () => {
    const out = applyFreeTierRequestContract(chatBody(), "openai", []);
    expect(out.stream).toBe(true);
    expect(out.tools.map((tool) => tool.function.name)).toEqual(["_noop"]);
    expect(out).not.toHaveProperty("tool_choice");
  });

  it("keeps client-supplied tools unchanged instead of appending placeholders", () => {
    const tool = { type: "function", function: { name: "client_tool", description: "real", parameters: { type: "object", properties: { value: { type: "string" } } } } };
    const out = applyFreeTierRequestContract({ ...chatBody(), tools: [tool] }, "openai", ["borrowed"]);
    expect(out.tools).toEqual([tool]);
    expect(out.tools[0]).toBe(tool);
  });

  it("uses flat tools for Responses and never guesses an Anthropic tool shape", () => {
    const responses = applyFreeTierRequestContract({ model: "muse-spark-1.3-contributor-free", input: [] }, "openai-responses", ["glob"]);
    expect(responses.tools).toEqual([expect.objectContaining({ type: "function", name: "glob" })]);

    const anthropic = applyFreeTierRequestContract({ model: "mimo-v2.5-free", messages: [] }, "anthropic-messages", ["glob"]);
    expect(anthropic.stream).toBe(true);
    expect(anthropic).not.toHaveProperty("tools");
  });

  it("validates, dedupes and caps configured placeholder names", () => {
    process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS = ["glob", "glob", "bad.dot", "1bad", ...Array.from({ length: 40 }, (_, i) => `tool_${i}`)].join(",");
    const names = configuredPlaceholderToolNames();
    expect(names).toHaveLength(32);
    expect(names.slice(0, 2)).toEqual(["glob", "tool_0"]);
  });

  it("learns only caller-supplied tools after a successful gated request", () => {
    const original = { ...chatBody(), tools: [{ type: "function", function: { name: "client_tool" } }] };
    const prepared = prepareFreeTierRequest(original, "openai", "zen", "opencode", "mimo-v2.5-free", "session-a");
    noteFreeTierOutcome(prepared.attempt, true);

    expect(getObservedToolNames("opencode", "mimo-v2.5-free", "session-a")).toEqual(["client_tool"]);
  });

  it("marks a no-tool request as borrowed and forgets the borrowed entry after three failures", () => {
    const taught = prepareFreeTierRequest({ ...chatBody(), tools: [{ type: "function", function: { name: "client_tool" } }] }, "openai", "zen", "opencode", "mimo-v2.5-free", "session-a");
    noteFreeTierOutcome(taught.attempt, true);

    for (let i = 0; i < 3; i++) {
      const borrowed = prepareFreeTierRequest(chatBody(), "openai", "zen", "opencode", "mimo-v2.5-free", "session-a");
      expect(borrowed.attempt.borrowed).toBe(true);
      expect(borrowed.body.tools.map((tool) => tool.function.name)).toEqual(["client_tool"]);
      noteFreeTierOutcome(borrowed.attempt, false);
    }

    expect(getObservedToolNames("opencode", "mimo-v2.5-free", "session-a")).toBeNull();
  });

  it("executor applies the contract only to gated free request formats", () => {
    const executor = new OpenCodeExecutor();
    const credentials = { _opencodeContractSession: "session-a" };

    const chat = executor.transformRequest("mimo-v2.5-free", chatBody(), false, credentials);
    expect(chat.stream).toBe(true);
    expect(chat.tools.map((tool) => tool.function.name)).toEqual(["_noop"]);

    const responses = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { model: "muse-spark-1.3-contributor-free", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      false,
      credentials,
    );
    expect(responses.tools.map((tool) => tool.name)).toEqual(["_noop"]);

    const anthropic = executor.transformRequest(
      "union-alpha",
      { model: "union-alpha", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
      false,
      credentials,
    );
    expect(anthropic).not.toHaveProperty("tools");
  });

  it("executor preserves caller tools without appending guessed names", () => {
    const executor = new OpenCodeExecutor();
    const tool = { type: "function", function: { name: "client_tool", parameters: { type: "object", properties: {} } } };
    const out = executor.transformRequest(
      "mimo-v2.5-free",
      { ...chatBody(), tools: [tool] },
      true,
      { _opencodeContractSession: "session-a" },
    );
    expect(out.tools).toEqual([tool]);
  });

  it("preserves Responses built-ins, custom tools, schemas and tool_choice exactly", () => {
    const tools = [
      { type: "web_search" },
      { type: "custom", name: "patch", format: { type: "text" } },
      { type: "function", name: "lookup", strict: true, parameters: { type: "object", properties: {}, additionalProperties: false } },
    ];
    const original = structuredClone(tools);
    const choice = { type: "function", name: "lookup" };
    const out = new OpenCodeExecutor().transformRequest(
      "muse-spark-1.3-contributor-free",
      { input: [{ role: "user", content: "hi" }], tools, tool_choice: choice },
      true,
      {},
    );
    expect(out.tools).toBe(tools);
    expect(out.tools).toEqual(original);
    expect(out.tool_choice).toBe(choice);
  });

  it("routes union-alpha through the registered Claude translator", () => {
    const target = getModelTargetFormat("oc", "union-alpha");
    const translated = translateRequest(FORMATS.OPENAI, target, "union-alpha", {
      messages: [{ role: "system", content: "be concise" }, { role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    }, true, {}, "opencode");
    const out = new OpenCodeExecutor().transformRequest("union-alpha", translated, true, {});
    expect(target).toBe(FORMATS.CLAUDE);
    expect(out.tools[0]).toMatchObject({ name: "lookup", input_schema: { type: "object" } });
    expect(out.tools[0]).not.toHaveProperty("function");
    expect(out.messages.every((message) => message.role !== "system")).toBe(true);
  });

  it("preserves the complete Responses terminal payload", async () => {
    const terminal = { id: "resp-1", object: "response", model: "muse-spark-1.3-contributor-free", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } } };
    const response = rebuildJsonFromForcedStream(new Response(
      `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    ), "openai-responses", terminal.model);
    expect(await response.json()).toEqual(terminal);
  });

  it("preserves an unparseable forced event stream body", async () => {
    const raw = "event: ping\ndata: not-json\n\n";
    const rebuilt = rebuildJsonFromForcedStream(
      new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }),
      "openai",
      "mimo-v2.5-free",
    );
    expect(rebuilt.headers.get("content-type")).toContain("application/json");
    expect(await rebuilt.text()).toBe(raw);
  });
});
