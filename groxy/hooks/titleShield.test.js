// Regression for the groxy process-name shield. 9router's
// killAllAppProcesses() sweeps ps lines matching either clause:
//
//   (node && 9router && (cli.js || /9router))   ||   next-server
//
// The shield renames the launcher title to "groxy" and the server title to
// "groxy-server" (via a poll that fights Next.js's "next-server (vX)"
// assignment). This test asserts those names dodge the matcher.
import { describe, expect, it } from "vitest";

function would9routerKill(line) {
  const cmd = line.toLowerCase();
  return (
    (cmd.includes("node") &&
      cmd.includes("9router") &&
      (cmd.includes("cli.js") || cmd.includes("/9router"))) ||
    cmd.includes("next-server")
  );
}

describe("groxy process names dodge 9router's kill sweep", () => {
  it("launcher title 'groxy' is safe", () => {
    expect(would9routerKill("12345 groxy")).toBe(false);
  });

  it("server title 'groxy-server' is safe", () => {
    expect(would9routerKill("12345 groxy-server")).toBe(false);
  });

  it("real 9router next-server still matches (negative control)", () => {
    expect(would9routerKill("12345 next-server (v16.3.4)")).toBe(true);
  });

  it("9router launcher (node + 9router path + cli.js) still matches", () => {
    expect(
      would9routerKill(
        "9999 node /opt/homebrew/lib/node_modules/9router/cli.js --tray",
      ),
    ).toBe(true);
  });
});

// Sanity: while groxy is alive on 20138, every line that matches
// 9router's kill sweep and looks like groxy (contains "groxy" or
// "groxy-server") must NOT be matched — that's the property the shield
// enforces. Lines that match and are clearly 9router's own (no "groxy")
// are expected and benign.
describe("live ps sweep does not select groxy", () => {
  it("any matched ps line that mentions groxy is a shield failure", async () => {
    const { spawnSync } = await import("node:child_process");
    const ps = spawnSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
    const lines = ps.stdout.split("\n").slice(1).filter(Boolean);
    for (const line of lines) {
      const cmd = line.toLowerCase();
      // Skip this test runner's own process tree: its argv contains both the
      // repo path ("9router") and the test path ("groxy"), which trips the
      // substring matcher as a false positive unrelated to the shield.
      if (cmd.includes("vitest") || cmd.includes("titleshield.test")) continue;
      const isHit =
        (cmd.includes("node") &&
          cmd.includes("9router") &&
          (cmd.includes("cli.js") || cmd.includes("/9router"))) ||
        cmd.includes("next-server");
      if (!isHit) continue;
      expect(
        cmd.includes("groxy"),
        `9router's kill sweep matched a groxy process — shield failed: ${line}`,
      ).toBe(false);
    }
  });
});
