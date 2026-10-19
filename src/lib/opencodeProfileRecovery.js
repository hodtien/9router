import { createHash } from "node:crypto";
import { getExecutor } from "open-sse/executors/index.js";
import {
  createPublicSessionCandidate,
  generateRequestId,
  publishPublicSessionCandidate,
} from "open-sse/executors/opencode.js";
import { convertResponsesStreamToJson } from "open-sse/transformer/streamToJsonConverter.js";
import {
  isOpencodeFreeTierRateLimitForProvider,
  isOpencodeFreeTierRefusalForProvider,
  isOpencodeGeoBlocked,
  isOpencodeUserBlocked,
} from "open-sse/executors/opencodeGeoBlock.js";
import {
  markOpenCodeProfileProbeFailed,
  refreshOpenCodeProfile,
} from "./opencodeProfile.js";

const PROBE_MAX_BYTES = 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
// ponytail: hardcode the probe target, but only until upstream retires it —
// 1.3 is deprecated upstream (410 ModelDeprecated), so the probe must follow the
// live Public catalog rather than a retired id. Swap when upstream says Gone.
const PROBE_MODEL = "muse-spark-1.2-contributor-free";
const recoveryFlights = new Map();
const PROBE_STAGES = new Set(["preflight", "candidate", "transport-spawn", "transport-metadata", "http-status", "stream-parse", "verify"]);
const UPSTREAM_CLASSES = new Set(["free-tier-rate-limit", "free-tier-refusal", "geo-blocked", "user-blocked", "unclassified"]);
// The executor tags only these two transport boundaries; everything else stays
// an unclassified transport failure so the enum can't drift from the executor.
const TRANSPORT_ERROR_STAGES = new Map([
  ["OPENCODE_TRANSPORT_SPAWN", "transport-spawn"],
  ["OPENCODE_TRANSPORT_METADATA", "transport-metadata"],
]);

function diagnostic(stage, upstreamClass) {
  return {
    ...(PROBE_STAGES.has(stage) ? { probeStage: stage } : {}),
    ...(UPSTREAM_CLASSES.has(upstreamClass) ? { upstreamClass } : {}),
  };
}

function classifyUpstream(status, body) {
  if (isOpencodeFreeTierRateLimitForProvider("opencode", status, body)) return "free-tier-rate-limit";
  if (isOpencodeGeoBlocked(status, body)) return "geo-blocked";
  if (isOpencodeUserBlocked(status, body)) return "user-blocked";
  if (isOpencodeFreeTierRefusalForProvider("opencode", status, body)) return "free-tier-refusal";
  return "unclassified";
}

function recoveryKey(proxyOptions = {}) {
  const identity = [proxyOptions.connectionId, proxyOptions.connectionName];
  const pool = proxyOptions.connectionProxyPoolId || proxyOptions.connectionProxyUrl || "default";
  return createHash("sha256").update(JSON.stringify({ identity, pool })).digest("hex").slice(0, 32);
}

function hasAssistantText(value) {
  return Array.isArray(value?.output)
    && value.output.some((item) => item?.type === "message"
      && item.role === "assistant"
      && Array.isArray(item.content)
      && item.content.some((part) => part?.type === "output_text"
        && typeof part.text === "string"
        && part.text.trim()));
}

async function readJsonResponseBounded(response) {
  if (!response?.body?.getReader) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let total = 0;
  const deadline = Date.now() + PROBE_TIMEOUT_MS;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("probe timeout");
      let timer;
      const read = reader.read();
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timeout")), remaining);
      });
      let part;
      try { part = await Promise.race([read, timed]); }
      finally { clearTimeout(timer); }
      if (part.done) break;
      total += part.value?.byteLength || 0;
      if (total > PROBE_MAX_BYTES) throw new Error("probe response too large");
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return JSON.parse(chunks.join(""));
  } finally {
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function validateProbeResponse(response) {
  if (!response?.ok) return false;
  let value;
  try {
    const contentType = response.headers?.get?.("content-type") || "";
    value = contentType.includes("text/event-stream")
      ? await convertResponsesStreamToJson(response.body, {
        maxBytes: PROBE_MAX_BYTES,
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      : await readJsonResponseBounded(response);
  } catch {
    return false;
  }
  return value?.status === "completed" && hasAssistantText(value);
}

async function runRecovery({ credentials, proxyOptions, force = false }) {
  const refreshed = await refreshOpenCodeProfile({ proxyOptions, force });
  if (refreshed.state !== "ready") return { ...refreshed, ...diagnostic("preflight") };

  const candidate = createPublicSessionCandidate(credentials);
  if (!candidate) return { state: "unsupported", proxy: refreshed.proxy, handoff: "unverified", ...diagnostic("candidate") };

  const rawHeaders = Object.fromEntries(
    Object.entries(credentials.rawHeaders || {})
      .filter(([key]) => !["x-opencode-session", "x-session-id", "x-opencode-request"].includes(key.toLowerCase())),
  );
  rawHeaders["x-opencode-session"] = candidate.sessionId;
  rawHeaders["x-opencode-request"] = generateRequestId();

  let valid = false;
  let probeStage = "transport-metadata";
  let upstreamClass;
  try {
    const result = await getExecutor("opencode").execute({
      model: PROBE_MODEL,
      body: {
        model: PROBE_MODEL,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
        stream: true,
        store: false,
        max_output_tokens: 16,
      },
      stream: true,
      credentials: { ...credentials, rawHeaders },
      providerSessionId: candidate.sessionId,
      clientTool: "opencode",
      proxyOptions,
      skipOpenCodeRecoveryOnRateLimit: true,
    });
    const response = result?.response;
    if (!response || typeof response.status !== "number") {
      // No Response means the transport never produced upstream metadata; a
      // rejected executor carries the finer spawn/metadata boundary instead.
      probeStage = "transport-metadata";
    } else if (!response.ok) {
      probeStage = "http-status";
      const body = await response?.clone?.().text?.().then((text) => text.slice(0, 8192)).catch(() => "") || "";
      upstreamClass = classifyUpstream(response?.status, body);
    } else {
      probeStage = "verify";
      valid = await validateProbeResponse(response);
      if (!valid) probeStage = "stream-parse";
    }
  } catch (error) {
    valid = false;
    probeStage = TRANSPORT_ERROR_STAGES.get(error?.code) || "transport-metadata";
  }
  if (!valid || !publishPublicSessionCandidate(candidate)) {
    if (typeof markOpenCodeProfileProbeFailed === "function") {
      await markOpenCodeProfileProbeFailed({ proxyOptions });
    }
    return { state: "failed", proxy: refreshed.proxy, handoff: "unverified", ...diagnostic(probeStage, upstreamClass) };
  }
  return {
    state: "ready",
    proxy: "configured",
    handoff: "verified",
    ...(refreshed.updatedAt ? { updatedAt: refreshed.updatedAt } : {}),
  };
}

export function startOpenCodeProfileRecovery(options = {}) {
  const key = recoveryKey(options.proxyOptions);
  const existing = recoveryFlights.get(key);
  if (existing) return existing;
  const flight = Promise.resolve()
    .then(() => runRecovery(options))
    .finally(() => recoveryFlights.delete(key));
  recoveryFlights.set(key, flight);
  return flight;
}

export function pendingOpenCodeProfileRecovery(proxyOptions = {}) {
  return recoveryFlights.get(recoveryKey(proxyOptions)) || null;
}

export async function recoverOpenCodeProfile(options = {}) {
  return startOpenCodeProfileRecovery(options);
}

export function resetOpenCodeProfileRecoveryForTests() {
  recoveryFlights.clear();
}
