import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { getThinkingLevels } from "../providers/thinkingLevels.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel } from "../providers/models/helpers.js";
import { ANTHROPIC_API_VERSION } from "../providers/shared.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";
import {
  applyFreeTierRecoveryContract,
  isGatedFreeTierRequest,
  noteFreeTierOutcome,
  prepareFreeTierRequest,
  rebuildJsonFromForcedStream,
} from "./opencodeFreeTierContract.js";
import {
  isOpencodeFreeTierRateLimitForProvider,
  isOpencodeFreeTierRefusalForProvider,
} from "./opencodeGeoBlock.js";

const OPENCODE_UA = "opencode/1.18.31";
const MAX_SESSION_LENGTH = 256;
const MAX_TOOL_NAME_LEN = 128;
const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeSession";
const CONTRACT_SESSION_FIELD = "_opencodeContractSession";
const CONTRACT_ATTEMPT_FIELD = "_opencodeContractAttempt";
const REQ_FIELD = "_opencodeRequest";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const OPENCODE_REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  return major > 1 || (major === 1 && minor >= 17);
}
// Models served by /zen/v1/responses; every other model stays on /chat/completions.
const RESPONSES_MODELS = new Set([
  "muse-spark-1.2-contributor-free",
  "muse-spark-1.3-contributor-free",
]);
// union-alpha was intentionally retired from the provider registry; keep the
// Messages branch available only if a model is reintroduced under a confirmed contract.
const ANTHROPIC_MESSAGES_MODELS = new Set();

// Replicate opencode's canonical descending identifier format. The first 12
// hex characters come from a per-millisecond counter; the final 14 are random.
let lastTimestamp = 0;
let counter = 0;

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

export function generateSessionId(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const value = ~current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `ses_${time}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  // Request IDs use the time-only derivation, matching OpenCode's identifier format.
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const digest = crypto
    .createHash("sha256")
    .update(`opencode\0${clientTool || "generic"}\0${sessionId || ""}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  return `ses_${timeHex}${randomPart}`;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function clientSuppliedSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  let fallback = null;
  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey !== SESSION_HEADER && normalizedKey !== "x-session-id") continue;
    const normalized = normalizeSession(value);
    if (!normalized) continue;
    if (normalizedKey === SESSION_HEADER) return normalized;
    fallback = normalized;
  }
  return fallback;
}

function nativeSession(headers) {
  const session = clientSuppliedSession(headers);
  return session && OPENCODE_SESSION_RE.test(session) ? session : null;
}

/* stable-session helpers */
// Upstream free-tier quota is accounted per session. Minting a fresh
// x-opencode-session on every request burns through it and surfaces as
// 429 FreeUsageLimitError with growing reset-after delays, while the real
// CLI reuses one long-lived canonical session per conversation. Mirror
// that: one stable canonical session per downstream identity, evicted
// after MEMORY_CONFIG.sessionTtlMs like the other session stores.
const stableOpencodeSessions = new Map();
const MAX_STABLE_SESSIONS = 1000;
const stableSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of stableOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      stableOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (stableSessionCleanup.unref) stableSessionCleanup.unref();

function identityKey(credentials) {
  const connectionId = credentials?.connectionId || credentials?.id;
  if (connectionId) return `opencode:conn:${String(connectionId).slice(0, 128)}`;
  const raw = credentials?.rawHeaders || {};
  const auth = raw.authorization || raw.Authorization || raw["x-api-key"] || raw["X-Api-Key"] || "";
  if (auth) {
    const digest = crypto.createHash("sha256").update(String(auth)).digest("hex").slice(0, 32);
    return `opencode:auth:${digest}`;
  }
  return "opencode:default";
}

export function stableSessionId(credentials) {
  const key = identityKey(credentials);
  const existing = stableOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    stableOpencodeSessions.delete(key);
    stableOpencodeSessions.set(key, existing);
    return existing.sessionId;
  }
  const sessionId = generateSessionId();
  if (stableOpencodeSessions.size >= MAX_STABLE_SESSIONS) {
    stableOpencodeSessions.delete(stableOpencodeSessions.keys().next().value);
  }
  stableOpencodeSessions.set(key, { sessionId, lastUsed: Date.now() });
  return sessionId;
}

function lastUserText(body) {
  try {
    if (!body || typeof body !== "object") return "";
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (!arr) return typeof body.input === "string" ? body.input.slice(-600) : "";
    for (let i = arr.length - 1; i >= 0; i--) {
      const msg = arr[i];
      if (!msg) continue;
      if (msg.role && msg.role !== "user") continue;
      const content = msg.content;
      if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
      if (Array.isArray(content)) {
        const text = content
          .map((part) => (typeof part === "string" ? part : part?.text || part?.input_text || ""))
          .join(" ")
          .trim();
        if (text) return text.slice(-600);
      }
    }
  } catch {
    return "";
  }
  return "";
}

// The real CLI sends the current user message id (stable per turn, same on
// retries) as x-opencode-request. Derive it deterministically from the
// session plus the last user message so retries share the id.
export function deriveRequestId(sessionId, body) {
  const text = lastUserText(body);
  if (!text) return generateRequestId();
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-req\0${sessionId || ""}\0${text}`)
    .digest();
  const timeHex = digest.subarray(0, 6).toString("hex");
  let randomPart = "";
  for (let i = 6; i < 20; i++) {
    randomPart += BASE62_CHARS[digest[i] % 62];
  }
  const id = `msg_${timeHex}${randomPart}`;
  return OPENCODE_REQUEST_RE.test(id) ? id : generateRequestId();
}

function normalizeRequestId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return OPENCODE_REQUEST_RE.test(normalized) ? normalized : null;
}

function bodyHasSessionHints(body) {
  try {
    if (!body || typeof body !== "object") return false;
    if (typeof body.session_id === "string" && body.session_id.trim()) return true;
    if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return true;
    if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) return true;
    if (body.metadata && typeof body.metadata.user_id === "string" && body.metadata.user_id.trim()) return true;
    if (body.request && body.request.sessionId != null && String(body.request.sessionId) !== "") return true;
    const arr = Array.isArray(body.messages)
      ? body.messages
      : Array.isArray(body.input)
        ? body.input
        : null;
    if (arr) {
      let assistantText = "";
      for (const msg of arr) {
        if (msg?.role === "assistant") {
          const content = msg.content;
          if (typeof content === "string") assistantText += content;
          else if (Array.isArray(content)) {
            for (const part of content) assistantText += part?.text || part?.output || "";
          }
          if (assistantText.length >= 50) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Strip the thinking suffix "model(level)" so registry lookups hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isResponsesModel(model) {
  const base = baseModelId(model);
  return RESPONSES_MODELS.has(base) || isMuseSparkModel(base);
}

function isAnthropicMessagesModel(model) {
  return ANTHROPIC_MESSAGES_MODELS.has(baseModelId(model));
}

function requestFormatForModel(model) {
  if (isResponsesModel(model)) return "openai-responses";
  if (isAnthropicMessagesModel(model)) return "anthropic-messages";
  return "openai";
}

function resolveOpencodeSession(body, credentials, providerSessionId, clientTool) {
  const headers = credentials?.rawHeaders || {};
  const native = nativeSession(headers);
  if (native) return native;

  let incoming = null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      incoming = normalizeSession(value);
      break;
    }
  }

  const hinted = incoming || normalizeSession(providerSessionId);
  if (hinted) return translateSessionId(hinted, clientTool);

  if (credentials?.connectionId || bodyHasSessionHints(body)) {
    let viaManager = null;
    try {
      viaManager = resolveSessionId({
        headers,
        body,
        connectionId: credentials?.connectionId,
        scope: "opencode",
      });
    } catch {
      viaManager = null;
    }
    if (viaManager) return translateSessionId(viaManager, clientTool);
  }

  return stableSessionId(credentials);
}

function resolveOpencodeRequestId(body, credentials, sessionId) {
  const raw = credentials?.rawHeaders || {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.toLowerCase() === "x-opencode-request") {
      const normalized = normalizeRequestId(value);
      if (normalized) return normalized;
      break;
    }
  }
  return deriveRequestId(sessionId, body);
}

function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const hasLegacyTools = body.tools.some((tool) => tool?.function && typeof tool.function === "object" && !Array.isArray(tool.function));
  if (!hasLegacyTools) return;

  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return true;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    if (!fn) return true;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) return false;
    const description = typeof fn.description === "string" ? fn.description : "";
    let parameters = fn.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
      ? fn.parameters
      : { type: "object", properties: {} };
    if (parameters.type === "object" && !parameters.properties) {
      parameters = { ...parameters, properties: {} };
    }
    for (const key of Object.keys(tool)) delete tool[key];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)
    && body.tool_choice.type === "function") {
    const name = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
    if (!name || !validNames.has(name)) delete body.tool_choice;
  }
}

function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items. OpenCode free uses pooled public
    // credentials, so encrypted reasoning can be invalid after account or proxy
    // rotation; store=false also rejects missing referenced blobs.
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

function normalizeOpencodeReasoning(model, body) {
  const current = body.reasoning;
  const currentReasoning = current && typeof current === "object" && !Array.isArray(current)
    ? current
    : null;
  const requestedEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : currentReasoning?.effort;
  if (typeof requestedEffort !== "string") return;

  const cleanModel = baseModelId(model || body.model);
  const supportedLevels = getThinkingLevels("opencode", cleanModel);
  let effort = requestedEffort.toLowerCase().trim();
  if ((effort === "max" || effort === "ultra") && supportedLevels?.length && !supportedLevels.includes(effort)) {
    if (effort === "ultra" && supportedLevels.includes("max")) effort = "max";
    else if (supportedLevels.includes("xhigh")) effort = "xhigh";
  }

  body.reasoning = { ...currentReasoning, effort };
  if (!body.reasoning.summary) body.reasoning.summary = "auto";
  delete body.reasoning_effort;
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  // Per-request credential copy avoids singleton executor state leaking between
  // concurrent requests while carrying both protocol identities.
  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const session = resolveOpencodeSession(body, sourceCredentials, providerSessionId, clientTool);

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: session,
      [REQ_FIELD]: resolveOpencodeRequestId(body, sourceCredentials, session),
      [CONTRACT_SESSION_FIELD]: clientSuppliedSession(sourceCredentials.rawHeaders) || undefined,
    };
  }

  transformRequest(model, body, stream, credentials) {
    if (body && typeof body === "object" && model && !body.model) body.model = model;
    let requestFormat = "openai";
    if (body && typeof body === "object") body.stream = true;
    if (isResponsesModel(model || body?.model) && body && typeof body === "object") {
      requestFormat = "openai-responses";
      const hasNativeResponsesTools = Array.isArray(body.tools)
        && body.tools.some((tool) => tool?.type !== "function");
      if ("tool_choice" in body && body.tool_choice !== "auto"
        && !hasNativeResponsesTools
        && this.config.quirks?.forceAutoToolChoiceModels?.includes(baseModelId(model))) {
        body.tool_choice = "auto";
      }
      const normalized = normalizeResponsesInput(body.input);
      if (normalized) body.input = normalized;
      if (!Array.isArray(body.input) || body.input.length === 0) {
        body.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
      }
      // Responses API names the output cap max_output_tokens; retain the free-tier
      // floor while mapping legacy client fields at this boundary.
      const clientCap = body.max_output_tokens
        ?? body.max_completion_tokens
        ?? body.max_tokens;
      if (clientCap === undefined || clientCap < 16) {
        body.max_output_tokens = 100000;
      } else if (body.max_output_tokens === undefined) {
        body.max_output_tokens = clientCap;
      }
      delete body.max_tokens;
      delete body.max_completion_tokens;
      normalizeOpencodeReasoning(model, body);
      body.stream = true;
      body.store = false;
      normalizeResponsesTools(body);
      sanitizeResponsesItems(body);
    }

    const transformedBody = injectReasoningContent({ provider: this.provider, model, body });
    const prepared = prepareFreeTierRequest(
      transformedBody,
      requestFormat,
      "zen",
      this.provider,
      model,
      credentials?.[CONTRACT_SESSION_FIELD],
    );
    if (credentials && typeof credentials === "object") {
      credentials[CONTRACT_ATTEMPT_FIELD] = prepared.attempt;
    }
    return prepared.body;
  }

  buildUrl(model) {
    const base = this.config.baseUrl;
    if (isResponsesModel(model)) return `${base}/zen/v1/responses`;
    if (isAnthropicMessagesModel(model)) return `${base}/zen/v1/messages`;
    return `${base}/zen/v1/chat/completions`;
  }

  buildHeaders(credentials, stream = true, url = "", model = "") {
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;

    const downstreamUa = lower["user-agent"] || "";
    const downstreamClient = lower["x-opencode-client"];
    const gated = isGatedFreeTierRequest("zen", this.provider, model);
    const synthesize = !/^(0|false|no|off)$/i.test(process.env.OPENCODE_SYNTHESIZE_CLI_HEADERS?.trim() || "");
    const configuredUa = process.env.OPENCODE_USER_AGENT?.trim();
    const defaultUa = configuredUa && (!gated || hasValidOpencodeVersion(configuredUa))
      ? configuredUa : OPENCODE_UA;
    const userAgent = hasValidOpencodeVersion(downstreamUa) ? downstreamUa : (synthesize ? defaultUa : null);
    const client = downstreamClient || (synthesize ? process.env.OPENCODE_CLIENT?.trim() || "desktop" : null);
    const project = lower["x-opencode-project"] || (synthesize ? process.env.OPENCODE_PROJECT?.trim() || "global" : null);

    const session = credentials?.[SESSION_FIELD] || this.prepareRequestCredentials({ credentials })[SESSION_FIELD];
    const downstreamReq = normalizeRequestId(lower["x-opencode-request"]);
    const requestId = credentials?.[REQ_FIELD] || downstreamReq || generateRequestId();

    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer public",
      ...(userAgent ? { "User-Agent": userAgent } : {}),
      ...(client ? { "x-opencode-client": client } : {}),
      "x-opencode-session": session,
      "x-opencode-request": requestId,
      ...(project ? { "x-opencode-project": project } : {}),
      "Accept": stream || gated ? "text/event-stream" : "*/*",
      "Accept-Language": lower["accept-language"] || "*",
      "sec-fetch-mode": lower["sec-fetch-mode"] || "cors",
      "Accept-Encoding": lower["accept-encoding"] || "br, gzip, deflate",
    };
    if (url?.endsWith("/messages")) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    return headers;
  }

  // ponytail: opencode free-tier gate fingerprints TLS ClientHello. Node
  // fetch (undici) returns 403 even with the right headers — the upstream
  // only accepts requests from Bun's TLS stack (or Electron's, which is what
  // the desktop app ships). We shell out to a tiny Bun script that performs
  // the actual HTTP request and pipes the response back. ponytail: this is
  // a per-request Bun spawn — overhead is ~30ms cold. For high-throughput,
  // promote to a long-lived Bun child process that streams many requests.
  async execute(args = {}) {
    const { model, body, credentials = {}, signal } = args;
    const canRecover = !args?._opencodeRecoveryAttempt
      && isGatedFreeTierRequest("zen", this.provider, model)
      && !signal?.aborted;
    const first = await this._executeOnce(args);
    const retryableStatus = first.response.status === 403
      || first.response.status === 429
      || first.response.status === 451;
    if (!canRecover || !retryableStatus) return first;
    let refusalBody;
    try { refusalBody = await first.response.text(); } catch { return first; }
    const isRefusal = isOpencodeFreeTierRefusalForProvider(
      this.provider,
      first.response.status,
      refusalBody,
    );
    const isRateLimit = isOpencodeFreeTierRateLimitForProvider(
      this.provider,
      first.response.status,
      refusalBody,
    );
    if (!isRefusal && !isRateLimit) {
      return { ...first, response: new Response(refusalBody, { status: first.response.status, headers: first.response.headers }) };
    }
    const retryBody = applyFreeTierRecoveryContract(first.transformedBody || body, requestFormatForModel(model));
    const retryCredentials = { ...credentials };
    const retryHeaders = { ...(credentials.rawHeaders || {}) };
    const suppliedSession = nativeSession(credentials.rawHeaders);
    if (isRateLimit) {
      retryHeaders["x-opencode-session"] = generateSessionId();
      retryHeaders["x-opencode-request"] = generateRequestId();
      retryCredentials.rawHeaders = retryHeaders;
    } else if (!suppliedSession) {
      retryHeaders["x-opencode-session"] = generateSessionId();
      retryCredentials.rawHeaders = retryHeaders;
    }
    const retry = await this._executeOnce({ ...args, body: retryBody, credentials: retryCredentials, _opencodeRecoveryAttempt: true }).catch(() => null);
    if (retry?.response?.ok) return retry;
    return { ...first, response: new Response(refusalBody, { status: first.response.status, headers: first.response.headers }) };
  }

  async _executeOnce({ model, body, stream, credentials, signal, log, providerSessionId, clientTool, _opencodeRecoveryAttempt = false, ...rest }) {
    const clientRequestedStream = stream;
    const preparedCredentials = this.prepareRequestCredentials({ body, credentials, providerSessionId, clientTool });
    const url = this.buildUrl(model, stream, 0, preparedCredentials);
    const transformedBody = this.transformRequest(model, { ...body, stream: !!stream }, stream, preparedCredentials);
    const upstreamStream = transformedBody?.stream === true;
    const headers = this.buildHeaders(preparedCredentials, upstreamStream, url, model);
    const attempt = preparedCredentials[CONTRACT_ATTEMPT_FIELD];
    const finalize = (result) => {
      if (!_opencodeRecoveryAttempt) noteFreeTierOutcome(attempt, result.response.ok);
      if (clientRequestedStream || !attempt) return result;
      const response = rebuildJsonFromForcedStream(
        result.response,
        requestFormatForModel(model),
        model,
      );
      return response === result.response ? result : { ...result, response };
    };

    const bunBin = process.env.BUN_BIN?.trim() || "bun";
    // ponytail: Next.js rewrites `import.meta.url` so the inlined path is
    // useless at runtime. Resolve the fetcher script from OPENCODE_FETCHER_PATH
    // (preferred) or fall back to the repo-relative location so a symlink or
    // copy placed at that path also works.
    const candidates = [
      process.env.OPENCODE_FETCHER_PATH?.trim(),
      "/Users/hodtien/Desktop/sourcecodes/github-code/9router/open-sse/executors/_opencode-fetcher.js",
      "/Users/hodtien/Desktop/sourcecodes/github-code/9router/cli/app/open-sse/executors/_opencode-fetcher.js",
    ].filter(Boolean);
    const fs = await import("node:fs");
    const scriptPath = candidates.find((p) => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    });
    if (!scriptPath) {
      throw new Error(`opencode Bun fetcher: script not found. Tried: ${candidates.join(", ")}. Set OPENCODE_FETCHER_PATH or copy _opencode-fetcher.js into cli/app.`);
    }

    const input = JSON.stringify({
      url,
      headers,
      body: JSON.stringify(transformedBody),
      stream: upstreamStream,
      // ponytail: opencode rate-limits per source IP. Pass the connection
      // proxy from the virtual noauth credentials so Bun's fetch() tunnels
      // out via that pool, refreshing the upstream rate-limit bucket.
      proxyUrl: credentials?.connectionProxyUrl || "",
    });

    const child = (await import("node:child_process")).spawn(bunBin, ["--cwd=/tmp", scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      // ponytail: Bun refuses to run when its captured parent-cwd was deleted
      // (e.g. after a deploy rotated /opt/groxy/app). Pin Bun's internal cwd
      // to /tmp via --cwd= so the spawn survives such rotations.
    });

    if (signal) {
      const onAbort = () => { if (!child.killed) child.kill("SIGTERM"); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => signal.removeEventListener?.("abort", onAbort));
    }

    child.stdin.end(input);

    if (upstreamStream) {
      // Wait for the metadata line before constructing Response. Returning
      // early would default every upstream error to HTTP 200 and turn its body
      // into an apparently successful empty SSE stream.
      return new Promise((resolve, reject) => {
        let headerBuf = Buffer.alloc(0);
        let controller = null;
        let stderr = "";
        let ended = false;

        child.stdout.on("data", (chunk) => {
          if (ended) return;
          if (controller) {
            controller.enqueue(chunk);
            return;
          }
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const nl = headerBuf.indexOf(0x0a);
          if (nl < 0) return;

          let metadata;
          try {
            metadata = JSON.parse(headerBuf.slice(0, nl).toString("utf8"));
          } catch (error) {
            reject(new Error(`opencode Bun fetcher: bad metadata: ${error.message}`));
            return;
          }
          const tail = headerBuf.slice(nl + 1);
          const responseBody = new ReadableStream({
            start(streamController) {
              controller = streamController;
              if (tail.length) controller.enqueue(tail);
            },
            cancel() {
              ended = true;
              if (!child.killed) child.kill("SIGTERM");
            },
          });
          resolve(finalize({
            response: new Response(responseBody, { status: metadata.status, headers: metadata.headers || {} }),
            url, headers, transformedBody,
          }));
        });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", (error) => {
          if (ended) return;
          ended = true;
          if (controller) controller.error(error);
          else reject(error);
        });
        child.on("close", (code) => {
          if (ended) return;
          ended = true;
          if (!controller) {
            reject(new Error(`opencode Bun fetcher exited before metadata (exit=${code}) stderr=${stderr.slice(0, 500)}`));
          } else if (code !== 0) {
            controller.error(new Error(`opencode Bun fetcher exit=${code} stderr=${stderr.slice(0, 500)}`));
          } else {
            controller.close();
          }
        });
      });
    }

    // Non-streaming: collect stdout then JSON.parse.
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    return new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
        if (code === 0) {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(stdoutChunks).toString("utf8"));
          } catch (e) {
            return reject(new Error(`opencode Bun fetcher: bad JSON output: ${e.message}`));
          }
          return resolve(finalize({
            response: new Response(parsed.body, {
              status: parsed.status,
              headers: parsed.headers,
            }),
            url, headers, transformedBody,
          }));
        }
        // ponytail: Bun hit a runtime error (TLS fingerprint rejection, rate-limit,
        // cwd issue). Fall back to a Node.js-native fetcher that uses undici's
        // TLS — different ClientHello signature from Bun, so the upstream
        // free-tier gate rate-limits them as separate buckets. When Bun is
        // burned (FreeUsageLimitError), Node often still works through a
        // different code path on the same IP.
        return tryNodeFallback({ resolve: (result) => resolve(finalize(result)), reject, input, url, headers, transformedBody, bunCode: code, bunStderr: stderr });
      });
    });
  }
}

// ponytail: fallback fetcher when Bun hits a TLS fingerprint block or runtime
// error. Uses Node's native fetch (undici TLS) — separate rate-limit bucket
// on opencode's free-tier gate. Spawned as a child process so the gateway
// doesn't drag the Node-only deps into its main bundle.
async function tryNodeFallback({ resolve, reject, input, url, headers, transformedBody, bunCode, bunStderr, bunStatus, bunBody }) {
  const nodeFallback = process.env.OPENCODE_NODE_FETCHER_PATH?.trim()
    || "/opt/groxy/app/_opencode-fetcher.mjs";
  const fs = await import("node:fs");
  if (!fs.existsSync(nodeFallback)) {
    const msg = bunStatus
      ? `opencode Bun fetcher HTTP ${bunStatus}: ${bunBody?.slice(0, 300)}`
      : `opencode Bun fetcher exit=${bunCode} stderr=${bunStderr}`;
    return reject(new Error(msg));
  }
  const cp = await import("node:child_process");
  const nodeChild = cp.spawn(process.execPath, [nodeFallback], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    cwd: "/tmp",
  });
  const out = [];
  const err = [];
  nodeChild.stdout.on("data", (c) => out.push(c));
  nodeChild.stderr.on("data", (c) => err.push(c));
  nodeChild.on("error", () => reject(new Error(`node-fallback spawn error`)));
  nodeChild.on("close", (ncode) => {
    if (ncode !== 0) {
      return reject(new Error(`opencode node-fallback exit=${ncode} stderr=${Buffer.concat(err).toString("utf8").slice(0, 500)}`));
    }
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(out).toString("utf8"));
    } catch (e) {
      return reject(new Error(`opencode node-fetcher: bad JSON output: ${e.message}`));
    }
    resolve({
      response: new Response(parsed.body, {
        status: parsed.status,
        headers: parsed.headers,
      }),
      url, headers, transformedBody,
    });
  });
  nodeChild.stdin.end(input);
}
