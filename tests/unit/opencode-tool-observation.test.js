import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetToolObservationForTests,
  getObservedToolNames,
  noteRefusedBorrowedToolNames,
  recordAcceptedToolNames,
  resolvePlaceholderNames,
} from "../../open-sse/executors/opencodeToolObservation.js";

const PROVIDER = "opencode";
const MODEL = "mimo-v2.5-free";

describe("OpenCode tool observation cache", () => {
  beforeEach(() => _resetToolObservationForTests());

  it("records session and model scopes, preferring the current session", () => {
    recordAcceptedToolNames(PROVIDER, MODEL, "session-a", ["bash", "read"]);
    recordAcceptedToolNames(PROVIDER, MODEL, "session-b", ["glob", "grep"]);

    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-a", ["configured"])).toEqual(["bash", "read"]);
    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-b", ["configured"])).toEqual(["glob", "grep"]);
    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-c", ["configured"])).toEqual(["glob", "grep"]);
  });

  it("falls back to configured names when nothing was observed", () => {
    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-a", ["configured"])).toEqual(["configured"]);
  });

  it("keeps valid unique names only and caps each entry at 32", () => {
    const names = [" valid-with-space ", "", "1bad", "bad.dot", "ok", "ok", ...Array.from({ length: 40 }, (_, i) => `tool_${i}`)];
    recordAcceptedToolNames(PROVIDER, MODEL, undefined, names);
    const observed = getObservedToolNames(PROVIDER, MODEL);

    expect(observed).toHaveLength(32);
    expect(observed[0]).toBe("ok");
    expect(observed).not.toContain(" valid-with-space ");
    expect(new Set(observed).size).toBe(observed.length);
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it("forgets a refused borrowed session entry after three consecutive refusals", () => {
    recordAcceptedToolNames(PROVIDER, MODEL, "session-a", ["session_tool"]);
    recordAcceptedToolNames(PROVIDER, MODEL, "session-b", ["model_tool"]);

    noteRefusedBorrowedToolNames(PROVIDER, MODEL, "session-a");
    noteRefusedBorrowedToolNames(PROVIDER, MODEL, "session-a");
    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-a", [])).toEqual(["session_tool"]);

    noteRefusedBorrowedToolNames(PROVIDER, MODEL, "session-a");
    expect(resolvePlaceholderNames(PROVIDER, MODEL, "session-a", [])).toEqual(["model_tool"]);
  });

  it("refreshes true LRU order when an existing entry is reconfirmed", () => {
    for (let i = 0; i < 64; i++) recordAcceptedToolNames(PROVIDER, `model-${i}`, undefined, [`tool_${i}`]);
    recordAcceptedToolNames(PROVIDER, "model-0", undefined, ["tool_0"]);
    recordAcceptedToolNames(PROVIDER, "model-64", undefined, ["tool_64"]);

    expect(getObservedToolNames(PROVIDER, "model-0")).toEqual(["tool_0"]);
    expect(getObservedToolNames(PROVIDER, "model-1")).toBeNull();
    expect(getObservedToolNames(PROVIDER, "model-64")).toEqual(["tool_64"]);
  });
});
