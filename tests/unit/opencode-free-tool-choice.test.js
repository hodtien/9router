import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

function makeChild(inputs) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => { child.killed = true; });
  child.stdin = {
    end: vi.fn((input) => {
      inputs.push(JSON.parse(input));
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(
          `${JSON.stringify({ status: 200, headers: { "content-type": "text/event-stream" } })}\ndata: [DONE]\n\n`,
        ));
        child.emit("close", 0);
      });
    }),
  };
  return child;
}

afterEach(() => {
  delete process.env.OPENCODE_FETCHER_PATH;
  spawnMock.mockReset();
});

// Break caught: opencode/muse-spark-1.3-contributor-free 400 vì upstream
// chỉ nhận tool_choice "auto"; named/required/none phải demote sang "auto".
const FREE_13 = "muse-spark-1.3-contributor-free";
const CREDS = { connectionId: "opencode-free-tool-choice-test" };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];
const TOOLS = [{ type: "function", name: "get_weather", description: "w", parameters: { type: "object", properties: {} } }];

function responsesBody(model, tool_choice) {
  const body = { model, input: structuredClone(INPUT), tools: structuredClone(TOOLS) };
  if (tool_choice !== undefined) body.tool_choice = tool_choice;
  return body;
}

describe("opencode Free 1.3 tool_choice auto-only", () => {
  it("khai quirk đúng model 1.3-Free trong registry", () => {
    expect(PROVIDERS.opencode.quirks?.forceAutoToolChoiceModels).toEqual([FREE_13]);
  });

  it.each([
    ["Responses named", { type: "function", name: "get_weather" }],
    ["Chat function named", { type: "function", function: { name: "get_weather" } }],
    ["Claude tool named", { type: "tool", name: "get_weather" }],
    ["required", "required"],
    ["none", "none"],
  ])("demote %s sang auto (plain và max)", (_label, choice) => {
    for (const model of [FREE_13, `${FREE_13}(max)`]) {
      const body = responsesBody(model, structuredClone(choice));
      const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
      expect(out.tool_choice).toBe("auto");
      expect(out.tools[0]).toEqual(TOOLS[0]);
      expect(out.tools.slice(1).map((tool) => tool.name)).toEqual(["bash", "glob", "grep", "read"]);
      expect(out.input).toEqual(INPUT);
    }
  });

  it("giữ auto và absent; tools/input nguyên vẹn", () => {
    const autoOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, "auto"), true, CREDS,
    );
    expect(autoOut.tool_choice).toBe("auto");
    expect(autoOut.tools[0]).toEqual(TOOLS[0]);
    expect(autoOut.tools.slice(1).map((tool) => tool.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(autoOut.input).toEqual(INPUT);

    const absentOut = new OpenCodeExecutor().transformRequest(
      FREE_13, responsesBody(FREE_13, undefined), true, CREDS,
    );
    expect("tool_choice" in absentOut).toBe(false);
    expect(absentOut.tools[0]).toEqual(TOOLS[0]);
    expect(absentOut.tools.slice(1).map((tool) => tool.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(absentOut.input).toEqual(INPUT);
  });

  it.each([
    ["1.2-Free", "muse-spark-1.2-contributor-free"],
    ["future 1.4-Free", "muse-spark-1.4-contributor-free"],
    ["Go id", "muse-spark-1.3-contributor"],
    ["non-Muse", "big-pickle"],
  ])("không đổi tool_choice của %s", (_label, model) => {
    const choice = { type: "function", name: "get_weather" };
    const body = responsesBody(model, structuredClone(choice));
    const out = new OpenCodeExecutor().transformRequest(model, body, true, CREDS);
    expect(out.tool_choice).toEqual(choice);
  });

  it("wire: execute sends choice auto through the Bun fetcher", async () => {
    const inputs = [];
    spawnMock.mockReturnValue(makeChild(inputs));
    process.env.OPENCODE_FETCHER_PATH = new URL("../../open-sse/executors/_opencode-fetcher.js", import.meta.url).pathname;
    const ex = new OpenCodeExecutor();
    const body = responsesBody(FREE_13, { type: "function", name: "get_weather" });
    const { url, transformedBody } = await ex.execute({
      model: FREE_13, body, stream: true, credentials: CREDS,
    });
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
    expect(transformedBody.tool_choice).toBe("auto");
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(inputs).toHaveLength(1);
    expect(inputs[0].url).toBe("https://opencode.ai/zen/v1/responses");
    expect(inputs[0].headers.Accept).toBe("text/event-stream");
    const sent = JSON.parse(inputs[0].body);
    expect(sent.tool_choice).toBe("auto");
    expect(sent.model).toBe(FREE_13);
    expect(sent.tools[0]).toEqual(TOOLS[0]);
    expect(sent.tools.slice(1).map((tool) => tool.name)).toEqual(["bash", "glob", "grep", "read"]);
    expect(sent.input).toEqual(INPUT);
  });
});
