import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "./dataDir.js";

const DEFAULT_MODEL = "opencode/muse-spark-1.3-contributor-free";
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const refreshFlights = new Map();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function profileRoot() {
  return process.env.OPENCODE_PROFILE_ROOT || path.join(DATA_DIR, "opencode-profiles");
}

function statePath(rootDir) {
  return path.join(rootDir, "state.json");
}

function profileKey(proxyOptions) {
  const value = proxyOptions.connectionProxyPoolId || proxyOptions.connectionProxyUrl;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function proxyConfig(proxyOptions = {}) {
  if (proxyOptions.connectionProxyEnabled !== true || !proxyOptions.connectionProxyUrl) {
    return { state: "direct-egress" };
  }
  if (proxyOptions.strictProxy !== true) {
    return { state: "proxy-not-strict" };
  }

  let parsed;
  try {
    parsed = new URL(proxyOptions.connectionProxyUrl);
  } catch {
    return { state: "invalid-proxy" };
  }
  if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname) {
    return { state: "invalid-proxy" };
  }

  return { state: "configured", url: String(proxyOptions.connectionProxyUrl).trim() };
}

export function buildProfileEnvironment({ baseEnv = process.env, profileDir, proxyUrl }) {
  const configDir = path.join(profileDir, "config");
  const dataDir = path.join(profileDir, "data");
  const cacheDir = path.join(profileDir, "cache");
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "TERM"]) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  Object.assign(env, {
    HOME: profileDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: "",
    no_proxy: "",
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
  });
  return env;
}

async function ensurePrivateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function writeState(file, value) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

function sanitizedStatus(state, proxyState) {
  return {
    state: state?.state || (proxyState === "configured" ? "not-created" : proxyState),
    proxy: proxyState === "configured" ? "configured" : "direct",
    handoff: state?.handoff || "unverified",
    updatedAt: state?.updatedAt || null,
  };
}

function spawnProbe({ env, model, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.env.OPENCODE_BIN || "opencode", [
      "run",
      "ping",
      "--model",
      model,
      "--format",
      "json",
    ], {
      cwd: "/tmp",
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill?.("SIGTERM");
      reject(Object.assign(new Error("profile probe timeout"), { code: "ETIMEDOUT" }));
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) child.kill?.("SIGTERM");
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.reduce((sum, item) => sum + item.length, 0) < 4096) stderr.push(chunk);
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(Object.assign(new Error("profile probe failed"), { code: `EXIT_${code}` }));
    });
    child.stdin?.end();
  });
}

async function refreshInternal({ proxyOptions, rootDir, now, cooldownMs, spawnImpl }) {
  const proxy = proxyConfig(proxyOptions);
  if (proxy.state !== "configured") return sanitizedStatus(null, proxy.state);

  await ensurePrivateDir(rootDir);
  const file = statePath(rootDir);
  const previous = await readState(file);
  if (["ready", "failed"].includes(previous?.state) && now - previous.updatedAt < cooldownMs) {
    return sanitizedStatus({ ...previous, state: "cooldown" }, "configured");
  }

  const profileDir = path.join(rootDir, "profile");
  await ensurePrivateDir(profileDir);
  try {
    await spawnProbe({
      env: buildProfileEnvironment({ profileDir, proxyUrl: proxy.url }),
      model: process.env.OPENCODE_PROFILE_PROBE_MODEL || DEFAULT_MODEL,
      timeoutMs: envNumber("OPENCODE_PROFILE_PROBE_TIMEOUT_MS", 60_000),
      spawnImpl,
    });
    const next = {
      state: "ready",
      handoff: "unverified",
      updatedAt: now,
      profileKey: profileKey(proxyOptions),
    };
    await writeState(file, next);
    return sanitizedStatus(next, "configured");
  } catch (error) {
    const next = { state: "failed", handoff: "unverified", updatedAt: now, errorCode: error.code || "PROBE_FAILED" };
    await writeState(file, next);
    return sanitizedStatus(next, "configured");
  }
}

export async function refreshOpenCodeProfile({
  proxyOptions = {},
  rootDir = path.join(profileRoot(), profileKey(proxyOptions)),
  now = Date.now(),
  cooldownMs = envNumber("OPENCODE_PROFILE_REFRESH_COOLDOWN_MS", DEFAULT_COOLDOWN_MS),
  spawnImpl = spawn,
} = {}) {
  const key = rootDir;
  if (refreshFlights.has(key)) return refreshFlights.get(key);
  const flight = refreshInternal({ proxyOptions, rootDir, now, cooldownMs, spawnImpl })
    .finally(() => refreshFlights.delete(key));
  refreshFlights.set(key, flight);
  return flight;
}

export async function getOpenCodeProfileStatus({ proxyOptions = {}, rootDir = path.join(profileRoot(), profileKey(proxyOptions)) } = {}) {
  const proxy = proxyConfig(proxyOptions);
  if (proxy.state !== "configured") return sanitizedStatus(null, proxy.state);
  const state = await readState(statePath(rootDir));
  return sanitizedStatus(state, "configured");
}

export function resetOpenCodeProfileStateForTests() {
  refreshFlights.clear();
}

export async function removeOpenCodeProfile(rootDir) {
  await rm(rootDir, { recursive: true, force: true });
}
