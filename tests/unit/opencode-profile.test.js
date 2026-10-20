import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

const {
  buildProfileEnvironment,
  refreshOpenCodeProfile,
  getOpenCodeProfileStatus,
  resetOpenCodeProfileStateForTests,
} = await import("../../src/lib/opencodeProfile.js");

function makeChild(exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit("close", 143));
  queueMicrotask(() => {
    child.stdout.emit("data", Buffer.from('{"session":"secret"}'));
    child.stderr.emit("data", Buffer.from("diagnostic"));
    child.emit("close", exitCode);
  });
  return child;
}

const proxyOptions = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://user:secret@proxy.example:8900",
  connectionNoProxy: "",
  strictProxy: true,
};

let rootDir;

beforeEach(async () => {
  mocks.spawn.mockReset();
  resetOpenCodeProfileStateForTests();
  rootDir = await mkdtemp(path.join(os.tmpdir(), "9router-opencode-profile-"));
});

afterEach(async () => {
  resetOpenCodeProfileStateForTests();
  await rm(rootDir, { recursive: true, force: true });
});

describe("OpenCode profile refresh", () => {
  it("rejects direct egress instead of pretending a fresh profile bypasses the limit", async () => {
    const result = await refreshOpenCodeProfile({
      proxyOptions: { connectionProxyEnabled: false },
      rootDir,
    });

    expect(result.state).toBe("direct-egress");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects a proxy pool that allows direct fallback", async () => {
    const result = await refreshOpenCodeProfile({
      proxyOptions: {
        ...proxyOptions,
        strictProxy: false,
      },
      rootDir,
    });

    expect(result.state).toBe("proxy-not-strict");
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("builds an isolated child environment without exposing proxy credentials", () => {
    const env = buildProfileEnvironment({
      baseEnv: { PATH: "/bin", HOME: "/production", OPENCODE_ENV_FILE: "/etc/groxy.env", OPENCODE_PROFILE_ROOT: "/production" },
      profileDir: "/tmp/profile",
      proxyUrl: proxyOptions.connectionProxyUrl,
    });

    expect(env.HOME).toBe("/tmp/profile");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/profile/config");
    expect(env.XDG_DATA_HOME).toBe("/tmp/profile/data");
    expect(env.HTTP_PROXY).toBe(proxyOptions.connectionProxyUrl);
    expect(env.HTTPS_PROXY).toBe(proxyOptions.connectionProxyUrl);
    expect(env).not.toHaveProperty("OPENCODE_SESSION_ID");
    expect(env).not.toHaveProperty("OPENCODE_ENV_FILE");
    expect(env).not.toHaveProperty("OPENCODE_PROFILE_ROOT");
    expect(env).not.toHaveProperty("JWT_SECRET");
    expect(env).not.toHaveProperty("API_KEY_SECRET");
  });

  it("runs one isolated probe and returns sanitized state", async () => {
    mocks.spawn.mockImplementation(() => makeChild(0));

    const result = await refreshOpenCodeProfile({ proxyOptions, rootDir });

    expect(result.state).toBe("ready");
    expect(result.proxy).toBe("configured");
    expect(result).not.toHaveProperty("proxyUrl");
    expect(result).not.toHaveProperty("output");
    expect(mocks.spawn).toHaveBeenCalledOnce();

    const [, args, options] = mocks.spawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(["run", "ping"]));
    expect(options.env.HTTP_PROXY).toBe(proxyOptions.connectionProxyUrl);
    expect(options.env.HOME).not.toBe(process.env.HOME);

    const stored = JSON.parse(await readFile(path.join(rootDir, "state.json"), "utf8"));
    expect(stored.state).toBe("ready");
    expect(JSON.stringify(stored)).not.toContain("secret");
    expect(JSON.stringify(stored)).not.toContain("proxy.example");
  });

  it("backs off after a failed probe instead of spawning repeatedly", async () => {
    mocks.spawn.mockImplementation(() => makeChild(1));

    const first = await refreshOpenCodeProfile({ proxyOptions, rootDir });
    expect(first.state).toBe("failed");
    expect(mocks.spawn).toHaveBeenCalledOnce();

    const second = await refreshOpenCodeProfile({ proxyOptions, rootDir });
    expect(second.state).toBe("cooldown");
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes and applies cooldown", async () => {
    mocks.spawn.mockImplementation(() => makeChild(0));

    const [first, second] = await Promise.all([
      refreshOpenCodeProfile({ proxyOptions, rootDir }),
      refreshOpenCodeProfile({ proxyOptions, rootDir }),
    ]);

    expect(first.state).toBe("ready");
    expect(second.state).toBe("ready");
    expect(mocks.spawn).toHaveBeenCalledOnce();

    const next = await refreshOpenCodeProfile({ proxyOptions, rootDir });
    expect(next.state).toBe("cooldown");
    expect(mocks.spawn).toHaveBeenCalledOnce();

    const status = await getOpenCodeProfileStatus({ proxyOptions, rootDir });
    expect(status.state).toBe("ready");
    expect(status.proxy).toBe("configured");
    expect(status).not.toHaveProperty("proxyUrl");
  });
});
