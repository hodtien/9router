import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshOpenCodeProfile, getOpenCodeProfileStatus } from "../../src/lib/opencodeProfile.js";

const STRICT_PROXY_URL = "http://user:secret@proxy.example:8900";

const proxyOptions = {
  connectionProxyEnabled: true,
  connectionProxyUrl: STRICT_PROXY_URL,
  connectionNoProxy: "",
  connectionProxyPoolId: "pool-1",
  strictProxy: true,
  vercelRelayUrl: "",
  connectionId: "noauth",
  connectionName: "Public",
};

// Parent-process secrets that must never reach the child environment.
const PARENT_SECRETS = {
  JWT_SECRET: "s3cret-jwt",
  API_KEY_SECRET: "s3cret-api",
  OPENCODE_AUTH_TOKEN: "s3cret-token",
  ANTHROPIC_API_KEY: "s3cret-anthropic",
  HTTP_PROXY: "http://proxy.example:8900",
  HTTPS_PROXY: "http://proxy.example:8900",
};

const savedSecrets = {};
beforeEach(() => {
  for (const [key, value] of Object.entries(PARENT_SECRETS)) {
    savedSecrets[key] = process.env[key];
    process.env[key] = value;
  }
});
const sandboxes = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(savedSecrets)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(sandboxes.splice(0).map((base) => rm(base, { recursive: true, force: true })));
});

function fakeSpawn({ stdout = "", stderr = "", exitCode = 0, hang = false } = {}) {
  const calls = [];
  const spawnImpl = (executable, argv, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.killed = false;
    child.unref = () => child;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    calls.push({ executable, argv, options });
    if (!hang) {
      queueMicrotask(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", exitCode, null);
        child.emit("close", exitCode, null);
      });
    }
    return child;
  };
  return { spawnImpl, calls };
}

function pathsOutput(rootDir) {
  return [
    `home       ${rootDir}`,
    `config     ${join(rootDir, "config", "opencode")}`,
    `data       ${join(rootDir, "data", "opencode")}`,
    `cache      ${join(rootDir, "cache", "opencode")}`,
    `state      ${join(rootDir, "state", "opencode")}`,
    "",
  ].join("\n");
}

async function makeSandbox() {
  const base = await mkdtemp(join(tmpdir(), "oc-profile-"));
  const rootDir = join(base, "pool-1");
  const globalHome = join(base, "global-home");
  const globalProfileFile = join(globalHome, ".config", "opencode", "opencode.json");
  const otherPoolFile = join(base, "pool-other", "config", "opencode.json");
  const opencodeBin = join(base, "opencode");
  const globalBefore = '{"model":"gpt-5"}';
  const otherPoolBefore = '{"pool":"other"}';
  await mkdir(rootDir, { recursive: true });
  await mkdir(dirname(globalProfileFile), { recursive: true });
  await mkdir(dirname(otherPoolFile), { recursive: true });
  await writeFile(globalProfileFile, globalBefore);
  await writeFile(otherPoolFile, otherPoolBefore);
  await writeFile(opencodeBin, "", { mode: 0o755 });
  sandboxes.push(base);
  return { base, rootDir, globalHome, globalProfileFile, globalBefore, otherPoolFile, otherPoolBefore, opencodeBin };
}

async function snapshot(dir) {
  const out = {};
  async function walk(d) {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else out[p.slice(dir.length)] = await readFile(p, "utf8");
    }
  }
  await walk(dir);
  return out;
}

// Real containment (resolve/relative), so root-evil or `..` traversal cannot pass.
function isInside(root, target) {
  if (typeof target !== "string" || target === "") return false;
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function expectSanitizedFailure(result, rootDir) {
  expect(result.state).toBe("failed");
  expect(result).toHaveProperty("proxy");
  expect(result).toHaveProperty("handoff");
  expect(result).toHaveProperty("updatedAt");
  const json = JSON.stringify(result);
  for (const forbidden of ["secret", "s3cret", "proxy.example", rootDir, "stderr-diagnostic"]) {
    expect(json).not.toContain(forbidden);
  }
}

// One successful refresh so the profile has a published state to protect.
async function seedReady(sandbox) {
  const { spawnImpl, calls } = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
  const result = await refreshOpenCodeProfile({
    proxyOptions,
    rootDir: sandbox.rootDir,
    opencodeBin: sandbox.opencodeBin,
    spawnImpl,
  });
  expect(result.state).toBe("ready");
  expect(calls).toHaveLength(1);
  return calls;
}

async function expectFailureKeepsState(sandbox, spawn) {
  const before = await snapshot(sandbox.rootDir);
  const result = await refreshOpenCodeProfile({
    proxyOptions,
    rootDir: sandbox.rootDir,
    opencodeBin: sandbox.opencodeBin,
    spawnImpl: spawn.spawnImpl,
    // Past any cooldown so the failing child is actually spawned.
    now: Date.now() + 86_400_000,
  });
  expectSanitizedFailure(result, sandbox.rootDir);
  expect(await snapshot(sandbox.rootDir)).toEqual(before);
  return result;
}

describe("OpenCode profile scope rejection", () => {
  it("rejects direct egress instead of pretending a fresh profile bypasses the limit", async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const result = await refreshOpenCodeProfile({
      proxyOptions: { ...proxyOptions, connectionProxyEnabled: false },
      spawnImpl,
    });
    expect(result.state).toBe("direct-egress");
    expect(calls).toHaveLength(0);
  });

  it("rejects a proxy pool that allows direct fallback", async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const result = await refreshOpenCodeProfile({
      proxyOptions: { ...proxyOptions, strictProxy: false },
      spawnImpl,
    });
    expect(result.state).toBe("proxy-not-strict");
    expect(calls).toHaveLength(0);
  });

  it("rejects a proxy on the wrong port", async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const result = await refreshOpenCodeProfile({
      proxyOptions: { ...proxyOptions, connectionProxyUrl: "http://proxy.example:8080" },
      spawnImpl,
    });
    expect(result.state).toBe("proxy-not-supported");
    expect(calls).toHaveLength(0);
  });

  it("rejects relay-backed proxy options", async () => {
    const { spawnImpl, calls } = fakeSpawn();
    const result = await refreshOpenCodeProfile({
      proxyOptions: { ...proxyOptions, vercelRelayUrl: "https://relay.example/relay" },
      spawnImpl,
    });
    // Relay cannot guarantee a strict direct proxy, so it is an unsupported proxy configuration.
    expect(result.state).toBe("proxy-not-supported");
    expect(calls).toHaveLength(0);
  });

  it("rejects a non-Public identity before any spawn or profile mutation", async () => {
    const sandbox = await makeSandbox();
    const before = await snapshot(sandbox.rootDir);
    const { spawnImpl, calls } = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
    const result = await refreshOpenCodeProfile({
      proxyOptions: { ...proxyOptions, connectionId: "conn-paid-1", connectionName: "Work" },
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl,
    });
    expect(result.state).toBe("unsupported");
    expect(calls).toHaveLength(0);
    expect(await snapshot(sandbox.rootDir)).toEqual(before);
    expect(await readFile(sandbox.globalProfileFile, "utf8")).toEqual(sandbox.globalBefore);
    expect(await readFile(sandbox.otherPoolFile, "utf8")).toEqual(sandbox.otherPoolBefore);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("OpenCode profile isolated CLI preflight", () => {
  it("runs the model-free debug paths preflight and returns ready", async () => {
    const sandbox = await makeSandbox();
    const { spawnImpl, calls } = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });

    const result = await refreshOpenCodeProfile({
      proxyOptions,
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl,
    });

    expect(result.state).toBe("ready");
    expect(result.proxy).toBe("configured");
    expect(result.handoff).toBe("unverified");
    expect(result.updatedAt).not.toBeNull();
    expect(calls).toHaveLength(1);

    const { executable, argv, options } = calls[0];
    expect(executable).toBe(sandbox.opencodeBin);
    expect(argv).toEqual(["debug", "paths"]);

    // cwd: real containment plus a distinct, empty, private directory under the profile root.
    expect(isInside(sandbox.rootDir, options.cwd)).toBe(true);
    expect(resolve(options.cwd)).not.toBe(resolve(sandbox.rootDir));
    const cwdStat = await stat(options.cwd);
    expect(cwdStat.isDirectory()).toBe(true);
    expect(cwdStat.mode & 0o077).toBe(0);
    expect(await readdir(options.cwd)).toEqual([]);

    // HOME and every profile pointer are contained in the isolated root, and the dirs exist.
    const env = options.env;
    expect(env.HOME).toBe(sandbox.rootDir);
    for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]) {
      expect(isInside(sandbox.rootDir, env[key])).toBe(true);
      const s = await stat(env[key]);
      expect(s.isDirectory()).toBe(true);
      expect(s.mode & 0o077).toBe(0);
    }
    for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"]) {
      expect(isInside(sandbox.rootDir, env[key])).toBe(true);
    }
    for (const key of ["JWT_SECRET", "API_KEY_SECRET", "OPENCODE_AUTH_TOKEN", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY"]) {
      expect(env).not.toHaveProperty(key);
    }

    const json = JSON.stringify(result);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain(sandbox.rootDir);
  });

  it("resets only the isolated pool profile and leaves global and other-pool files untouched", async () => {
    const sandbox = await makeSandbox();
    const savedHome = process.env.HOME;
    const savedXdgConfig = process.env.XDG_CONFIG_HOME;
    process.env.HOME = sandbox.globalHome;
    process.env.XDG_CONFIG_HOME = join(sandbox.globalHome, ".config");
    try {
      // Stale artifact inside THIS pool's isolated profile: refresh must reset it.
      const staleArtifact = join(sandbox.rootDir, "config", "opencode", "auth.json");
      const staleAuth = '{"token":"stale-pool-token"}';
      const staleSession = join(sandbox.rootDir, "data", "opencode", "session.db");
      await mkdir(dirname(staleArtifact), { recursive: true });
      await mkdir(dirname(staleSession), { recursive: true });
      await writeFile(staleArtifact, staleAuth);
      await writeFile(staleSession, "stale");

      const result = await refreshOpenCodeProfile({
        proxyOptions,
        rootDir: sandbox.rootDir,
        opencodeBin: sandbox.opencodeBin,
        spawnImpl: fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) }).spawnImpl,
      });
      expect(result.state).toBe("ready");

      // Isolated profile was actually reset: no stale token artifact survives.
      await expect(stat(staleArtifact)).rejects.toThrow();
      expect(
        JSON.stringify((await snapshot(sandbox.rootDir)) || {}),
      ).not.toContain("stale");

      // Global and other-pool profiles stay byte-identical.
      expect(await readFile(sandbox.globalProfileFile, "utf8")).toEqual(sandbox.globalBefore);
      expect(await readFile(sandbox.otherPoolFile, "utf8")).toEqual(sandbox.otherPoolBefore);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdgConfig;
    }
  });

  it("reports ready status after a successful refresh without leaking paths or secrets", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);

    const status = await getOpenCodeProfileStatus({ proxyOptions, rootDir: sandbox.rootDir });
    expect(status.state).toBe("ready");
    expect(status.proxy).toBe("configured");
    const json = JSON.stringify(status);
    expect(json).not.toContain("secret");
    expect(json).not.toContain(sandbox.rootDir);
  });

  it("status reports direct egress when no proxy is configured", async () => {
    const status = await getOpenCodeProfileStatus({ proxyOptions: { connectionProxyEnabled: false } });
    expect(status.state).toBe("direct-egress");
  });
});

describe("OpenCode profile preflight failures", () => {
  it("returns sanitized failed when the child exits nonzero and keeps the previous state", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    await expectFailureKeepsState(
      sandbox,
      fakeSpawn({ stdout: pathsOutput(sandbox.rootDir), stderr: "stderr-diagnostic raw dump", exitCode: 1 }),
    );
  });

  it("returns sanitized failed when the child never exits and keeps the previous state", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    const before = await snapshot(sandbox.rootDir);
    const { spawnImpl } = fakeSpawn({ hang: true });

    vi.useFakeTimers();
    try {
      const pending = refreshOpenCodeProfile({
        proxyOptions,
        rootDir: sandbox.rootDir,
        opencodeBin: sandbox.opencodeBin,
        spawnImpl,
        now: Date.now() + 86_400_000,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      const result = await pending;
      expectSanitizedFailure(result, sandbox.rootDir);
      expect(await snapshot(sandbox.rootDir)).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns sanitized failed for malformed debug paths output and keeps the previous state", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    await expectFailureKeepsState(sandbox, fakeSpawn({ stdout: "not a paths listing\n" }));
  });

  it("returns sanitized failed when a reported path escapes the isolated root and keeps the previous state", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    const output = [
      `home       ${sandbox.rootDir}`,
      "config     /etc/opencode",
      `data       ${join(sandbox.rootDir, "data", "opencode")}`,
      `cache       ${join(sandbox.rootDir, "cache", "opencode")}`,
      `state      ${join(sandbox.rootDir, "state", "opencode")}`,
      "",
    ].join("\n");
    await expectFailureKeepsState(sandbox, fakeSpawn({ stdout: output }));
  });

  it("returns sanitized failed when stdout exceeds the byte cap and keeps the previous state", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    // Valid header plus padding: any impl cap must be <= 2 MiB and must treat overflow as failure.
    const output = pathsOutput(sandbox.rootDir) + "x".repeat(2 * 1024 * 1024);
    await expectFailureKeepsState(sandbox, fakeSpawn({ stdout: output }));
  });
});

describe("OpenCode profile cooldown", () => {
  // Impl-owned state file location (src/lib/opencodeProfile.js:208).
  const STATE_FILE = (d) => join(d, "state", "opencode-cli-profile.json");

  async function findStateFile(rootDir) {
    const p = STATE_FILE(rootDir);
    return (await stat(p).then(() => true, () => false)) ? p : null;
  }

  it("returns cooldown for a second refresh without spawning the CLI", async () => {
    const sandbox = await makeSandbox();
    const calls = await seedReady(sandbox);

    const secondSpawn = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
    const second = await refreshOpenCodeProfile({
      proxyOptions,
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl: secondSpawn.spawnImpl,
      cooldownMs: 60_000,
      now: Date.now() + 1_000,
    });

    expect(second.state).toBe("cooldown");
    expect(calls).toHaveLength(1);
    expect(secondSpawn.calls).toHaveLength(0);
    expect(JSON.stringify(second)).not.toContain("secret");
  });

  it("restores the old profile if recreation fails after the backup rename", async () => {
    const sandbox = await makeSandbox();
    const before = await snapshot(sandbox.rootDir);
    const { spawnImpl, calls } = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
    const mkdirImpl = vi.fn(async () => {
      throw new Error("recreation failed");
    });

    const result = await refreshOpenCodeProfile({
      proxyOptions,
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl,
      mkdirImpl,
      now: Date.now() + 86_400_000,
    });

    expectSanitizedFailure(result, sandbox.rootDir);
    expect(calls).toHaveLength(0);
    expect(await snapshot(sandbox.rootDir)).toEqual(before);
  });

  it("returns cooldown from a seeded persisted state file without spawning the CLI", async () => {
    const sandbox = await makeSandbox();

    // Seed a fresh state file the same way the implementation does, then reuse it verbatim.
    await seedReady(sandbox);
    const stateFile = await findStateFile(sandbox.rootDir);
    expect(stateFile).not.toBeNull();
    const seeded = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(seeded);
    expect(parsed.state).toBe("ready");
    expect(parsed).not.toHaveProperty("proxyUrl");
    expect(seeded).not.toContain("secret");

    // Reload path: a NEW process instance (no in-memory cooldown) reads only this file.
    const spawnCalls = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
    const reloaded = await refreshOpenCodeProfile({
      proxyOptions,
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl: spawnCalls.spawnImpl,
      cooldownMs: 60_000,
    });

    expect(reloaded.state).toBe("cooldown");
    expect(spawnCalls.calls).toHaveLength(0);
    expect(await readFile(stateFile, "utf8")).toEqual(seeded);
    expect(JSON.stringify(reloaded)).not.toContain("secret");
  });

  it("re-runs after the seeded cooldown has elapsed", async () => {
    const sandbox = await makeSandbox();
    await seedReady(sandbox);
    const stateFile = await findStateFile(sandbox.rootDir);
    expect(stateFile).not.toBeNull();
    const seeded = JSON.parse(await readFile(stateFile, "utf8"));

    const seededAt = Date.parse(seeded.updatedAt ?? seeded.timestamp ?? seeded.at);
    expect(Number.isFinite(seededAt)).toBe(true);

    const postCooldown = fakeSpawn({ stdout: pathsOutput(sandbox.rootDir) });
    const result = await refreshOpenCodeProfile({
      proxyOptions,
      rootDir: sandbox.rootDir,
      opencodeBin: sandbox.opencodeBin,
      spawnImpl: postCooldown.spawnImpl,
      cooldownMs: 60_000,
      now: seededAt + 61_000,
    });

    expect(result.state).toBe("ready");
    expect(postCooldown.calls).toHaveLength(1);
  });
});
