import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

// Codex /responses rejects any input item whose `name` violates ^[a-zA-Z0-9_-]+$.
// OMP replays historical function_call / custom_tool_call items that can carry dots,
// spaces or unicode. These tests lock in the minimal fix: rewrite ONLY offending
// input names, preserve valid ones byte-for-byte, never invent a name, and leave tool
// definitions / tool_choice untouched so response tool dispatch stays intact.

function run(input, extra = {}) {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.5",
    input,
    stream: true,
    ...extra,
  };
  executor.transformRequest("gpt-5.5", body, true, {
    connectionId: "test-codex-input-names",
    providerSpecificData: {},
  });
  return body;
}

describe("CodexExecutor input item name sanitization", () => {
  it("rewrites an invalid historical function_call name (dots)", () => {
    const body = run([
      { type: "function_call", call_id: "c1", name: "web.search.tool", arguments: "{}" },
    ]);
    expect(body.input[0].name).toBe("web_search_tool");
    expect(/^[a-zA-Z0-9_-]+$/.test(body.input[0].name)).toBe(true);
    // call_id (the field the client actually dispatches on) is preserved
    expect(body.input[0].call_id).toBe("c1");
  });

  it("rewrites invalid custom_tool_call names (spaces + unicode)", () => {
    const body = run([
      { type: "custom_tool_call", call_id: "c2", name: "apply patch", input: "..." },
      { type: "custom_tool_call", call_id: "c3", name: "工具.run", input: "..." },
    ]);
    expect(body.input[0].name).toBe("apply_patch");
    expect(body.input[1].name).toBe("___run");
    for (const item of body.input) {
      expect(/^[a-zA-Z0-9_-]+$/.test(item.name)).toBe(true);
    }
  });

  it("preserves valid names byte-for-byte (incl hyphen/underscore/digits)", () => {
    const valid = ["read_file", "web-search", "Tool9", "A_b-C9"];
    const body = run(valid.map((name, i) => ({ type: "function_call", call_id: `c${i}`, name, arguments: "{}" })));
    expect(body.input.map((it) => it.name)).toEqual(valid);
  });

  it("leaves items with an absent or empty name untouched (never invents one)", () => {
    const body = run([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "c1", arguments: "{}" }, // no name
      { type: "function_call", call_id: "c2", name: "", arguments: "{}" }, // empty name
    ]);
    expect("name" in body.input[0]).toBe(false);
    expect("name" in body.input[1]).toBe(false);
    expect(body.input[2].name).toBe("");
  });

  it("tolerates non-object / null input entries without crashing", () => {
    const body = run([
      null,
      "just-a-string",
      [{ type: "function_call", name: "a.b" }],
      { type: "function_call", call_id: "c1", name: "ok.name", arguments: "{}" },
    ]);
    // the one real offending object got fixed; the junk entries were skipped
    const fn = body.input.find((it) => it && typeof it === "object" && !Array.isArray(it) && it.type === "function_call");
    expect(fn.name).toBe("ok_name");
  });

  it("does not rename tool definitions or drop tool_choice (definitions/choice stay consistent)", () => {
    const body = run(
      [{ type: "function_call", call_id: "c1", name: "web.search", arguments: "{}" }],
      {
        tools: [
          { type: "function", name: "web_search", parameters: { type: "object", properties: {} } },
          { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
          { type: "namespace", name: "codex_app", tools: [{ type: "function", name: "automation.update" }, null] },
        ],
        tool_choice: { type: "function", name: "web_search" },
      },
    );
    // input history name fixed
    expect(body.input[0].name).toBe("web_search");
    // function definition name untouched (already valid)
    expect(body.tools[0].name).toBe("web_search");
    // custom freeform tool passed through intact
    expect(body.tools[1]).toMatchObject({ type: "custom", name: "apply_patch" });
    // namespace sub-tool with a null entry survives (no crash) and its dotted name is NOT rewritten
    expect(body.tools[2].tools[1]).toBeNull();
    expect(body.tools[2].tools[0].name).toBe("automation.update");
    // tool_choice referencing a valid definition is preserved
    expect(body.tool_choice).toEqual({ type: "function", name: "web_search" });
  });

  it("colliding sanitized history names do not crash and both become valid", () => {
    // "a.b" and "a_b" both map to "a_b" — fine for transcript items (dispatch is by call_id)
    const body = run([
      { type: "function_call", call_id: "c1", name: "a.b", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "a_b", arguments: "{}" },
    ]);
    expect(body.input[0].name).toBe("a_b");
    expect(body.input[1].name).toBe("a_b");
    expect(body.input[0].call_id).toBe("c1");
    expect(body.input[1].call_id).toBe("c2");
  });

  it("works when no tools are present (historical calls only)", () => {
    const body = run([
      { type: "function_call", call_id: "c1", name: "legacy.tool", arguments: "{}" },
    ]);
    expect(body.input[0].name).toBe("legacy_tool");
    expect(body.tools).toBeUndefined();
  });
});
