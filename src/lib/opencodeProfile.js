import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./dataDir.js";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const refreshFlights = new Map();
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "TERM"];
const REQUIRED_PATH_KEYS = ["config", "data", "cache", "state"];

function sanitizedStatus(state, proxyState) {
  return {
    state: state?.state || (proxyState === "configured" ? "not-created" : proxyState),
    proxy: proxyState === "configured" ? "configured" : "direct",
    handoff: "unverified",
    updatedAt: state?.updatedAt || null,
  };
}

function numberOption(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function profileKey(proxyOptions) {
  const identity = [proxyOptions.connectionId, proxyOptions.connectionName];
  const pool = proxyOptions.connectionProxyPoolId || proxyOptions.connectionProxyUrl || "default";
  return createHash("sha256").update(JSON.stringify({ identity, pool })).digest("hex").slice(0, 16);
}

function defaultRootDir(proxyOptions) {
  return path.join(DATA_DIR, "opencode-cli-profiles", profileKey(proxyOptions));
}

function validateScope(proxyOptions = {}) {
  if (proxyOptions.connectionProxyEnabled !== true || !proxyOptions.connectionProxyUrl) {
    return { state: "direct-egress" };
  }
  if (proxyOptions.strictProxy !== true) return { state: "proxy-not-strict" };
  if (proxyOptions.vercelRelayUrl) return { state: "proxy-not-supported" };

  if (proxyOptions.connectionId !== "noauth" || proxyOptions.connectionName !== "Public") {
    return { state: "unsupported" };
  }

  try {
    const parsed = new URL(proxyOptions.connectionProxyUrl);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.port !== "8900") {
      return { state: "proxy-not-supported" };
    }
    return { state: "configured", url: String(proxyOptions.connectionProxyUrl).trim() };
  } catch {
    return { state: "proxy-not-supported" };
  }
}

async function ensurePrivateDir(dir, mkdirImpl = mkdir) {
  await mkdirImpl(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
    return null;
  }
}

async function writeState(file, state) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function buildChildEnvironment({ profileRoot, baseEnv = process.env }) {
  const config = path.join(profileRoot, "config");
  const data = path.join(profileRoot, "data");
  const cache = path.join(profileRoot, "cache");
  const state = path.join(profileRoot, "state");
  const env = {};
  for (const key of SAFE_ENV_KEYS) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  return {
    ...env,
    HOME: profileRoot,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: state,
    OPENCODE_CONFIG: path.join(config, "opencode.json"),
    OPENCODE_CONFIG_DIR: path.join(config, "assets"),
  };
}

function parseDebugPaths(output, profileRoot) {
  const paths = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^(config|data|cache|state)\s+(\S+)$/.exec(line.trim());
    if (!match || paths.has(match[1]) || !path.isAbsolute(match[2])) continue;
    paths.set(match[1], match[2]);
  }
  if (paths.size !== REQUIRED_PATH_KEYS.length) return false;
  const root = path.resolve(profileRoot);
  return REQUIRED_PATH_KEYS.every((key) => {
    const target = path.resolve(paths.get(key));
    const relative = path.relative(root, target);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

async function runIsolatedCliPreflight({ profileRoot, opencodeBin = "opencode", spawnImpl = spawn, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES, timeoutAt = Date.now() + timeoutMs, mkdirImpl = mkdir }) {
  const env = buildChildEnvironment({ profileRoot });
  const cwd = path.join(profileRoot, "cwd");
  await ensurePrivateDir(cwd, mkdirImpl);
  if (Date.now() >= timeoutAt) return { ok: false, code: "CLI_PREFLIGHT_TIMEOUT" };

  let child;
  try {
    child = spawnImpl(opencodeBin, ["debug", "paths"], {
      cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return { ok: false, code: "CLI_PREFLIGHT_FAILED" };
  }

  return new Promise((resolve) => {
    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    let overflow = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const collect = (chunk, destination) => {
      if (settled || overflow) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += value.length;
      if (outputBytes > maxBytes) {
        overflow = true;
        child.kill?.("SIGTERM");
        return;
      }
      if (destination) stdout.push(value);
    };
    const timer = setTimeout(() => {
      child.kill?.("SIGTERM");
      finish({ ok: false, code: "CLI_PREFLIGHT_TIMEOUT" });
    }, Math.max(0, timeoutAt - Date.now()));

    child.stdout?.on("data", (chunk) => collect(chunk, true));
    child.stderr?.on("data", (chunk) => collect(chunk, false));
    child.once("error", () => finish({ ok: false, code: "CLI_PREFLIGHT_FAILED" }));
    child.once("close", (code) => {
      if (settled) return;
      if (overflow) return finish({ ok: false, code: "CLI_PREFLIGHT_FAILED" });
      if (code !== 0) return finish({ ok: false, code: "CLI_PREFLIGHT_FAILED" });
      const valid = parseDebugPaths(Buffer.concat(stdout).toString("utf8"), profileRoot);
      finish(valid ? { ok: true } : { ok: false, code: "CLI_PREFLIGHT_PATH_MISMATCH" });
    });
    child.stdin?.end();
  });
}

async function replaceWithFreshProfile(rootDir) {
  const backup = `${rootDir}.backup-${process.pid}-${Date.now()}`;
  let hadPrevious = false;
  try {
    await rename(rootDir, backup);
    hadPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { backup, hadPrevious };
}

async function restoreProfile(rootDir, backup, hadPrevious) {
  await rm(rootDir, { recursive: true, force: true });
  if (hadPrevious) await rename(backup, rootDir);
}

async function refreshWork({ proxyOptions, rootDir, now, cooldownMs, spawnImpl, opencodeBin, timeoutMs, maxBytes, timeoutAt, mkdirImpl = mkdir, force = false }) {
  const proxy = validateScope(proxyOptions);
  if (proxy.state !== "configured") return sanitizedStatus(null, proxy.state);
  const deadline = timeoutAt ?? (Date.now() + timeoutMs);
  if (Date.now() >= deadline) return sanitizedStatus({ state: "failed", updatedAt: new Date(now).toISOString() }, "configured");

  const stateFile = path.join(rootDir, "state", "opencode-cli-profile.json");
  const previous = await readState(stateFile);
  const previousAt = Date.parse(previous?.updatedAt) || Number(previous?.updatedAt);
  if (!force && ["ready", "failed"].includes(previous?.state) && Number.isFinite(previousAt) && now - previousAt < cooldownMs) {
    return sanitizedStatus({ ...previous, state: "cooldown" }, "configured");
  }

  let replacement;
  try {
    replacement = await replaceWithFreshProfile(rootDir);
    await ensurePrivateDir(rootDir, mkdirImpl);
    const dirs = ["config", "data", "cache", "state", "config/assets"];
    for (const dir of dirs) await ensurePrivateDir(path.join(rootDir, dir), mkdirImpl);
    await writeFile(path.join(rootDir, "config/opencode.json"), "{}\n", { mode: 0o600 });
    await chmod(path.join(rootDir, "config/opencode.json"), 0o600);

    const preflight = await runIsolatedCliPreflight({
      profileRoot: rootDir,
      opencodeBin,
      spawnImpl,
      timeoutMs,
      maxBytes,
      timeoutAt,
      mkdirImpl,
    });
    if (!preflight.ok) throw new Error(preflight.code);

    const next = { state: "ready", handoff: "unverified", updatedAt: new Date(now).toISOString() };
    await writeState(stateFile, next);
    if (replacement.hadPrevious) await rm(replacement.backup, { recursive: true, force: true });
    return sanitizedStatus(next, "configured");
  } catch {
    if (replacement) {
      try {
        await restoreProfile(rootDir, replacement.backup, replacement.hadPrevious);
      } catch {
        // Keep diagnostics out of the API response; the next refresh can retry.
      }
    }
    return sanitizedStatus({ state: "failed", handoff: "unverified", updatedAt: new Date(now).toISOString() }, "configured");
  }
}

export async function refreshOpenCodeProfile({
  proxyOptions = {},
  rootDir = defaultRootDir(proxyOptions),
  now = Date.now(),
  cooldownMs = numberOption(process.env.OPENCODE_PROFILE_REFRESH_COOLDOWN_MS, DEFAULT_COOLDOWN_MS),
  timeoutMs = numberOption(process.env.OPENCODE_PROFILE_PROBE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  maxBytes = MAX_OUTPUT_BYTES,
  opencodeBin = process.env.OPENCODE_BIN || "opencode",
  spawnImpl = spawn,
  mkdirImpl = mkdir,
  force = false,
} = {}) {
  const key = String(rootDir);
  if (refreshFlights.has(key)) return refreshFlights.get(key);
  const flight = refreshWork({ proxyOptions, rootDir, now, cooldownMs, spawnImpl, opencodeBin, timeoutMs, maxBytes, mkdirImpl, force, timeoutAt: Date.now() + timeoutMs })
    .finally(() => refreshFlights.delete(key));
  refreshFlights.set(key, flight);
  return flight;
}

export async function getOpenCodeProfileStatus({ proxyOptions = {}, rootDir = defaultRootDir(proxyOptions) } = {}) {
  const proxy = validateScope(proxyOptions);
  if (proxy.state !== "configured") return sanitizedStatus(null, proxy.state);
  const state = await readState(path.join(rootDir, "state", "opencode-cli-profile.json"));
  return sanitizedStatus(state, "configured");
}

export async function markOpenCodeProfileProbeFailed({ proxyOptions = {}, rootDir = defaultRootDir(proxyOptions), now = Date.now() } = {}) {
  const proxy = validateScope(proxyOptions);
  if (proxy.state !== "configured") return sanitizedStatus(null, proxy.state);
  const state = { state: "failed", handoff: "unverified", updatedAt: new Date(now).toISOString() };
  try {
    await ensurePrivateDir(path.join(rootDir, "state"));
    await writeState(path.join(rootDir, "state", "opencode-cli-profile.json"), state);
  } catch {
    // Probe diagnostics stay out of the API response; the next refresh can retry.
  }
  return sanitizedStatus(state, "configured");
}

export function resetOpenCodeProfileStateForTests() {
  refreshFlights.clear();
}

export async function removeOpenCodeProfile(rootDir) {
  await rm(rootDir, { recursive: true, force: true });
}
