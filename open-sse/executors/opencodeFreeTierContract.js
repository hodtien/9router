import { parseSSEToOpenAIResponse } from "../handlers/sseParser.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";
import {
  noteRefusedBorrowedToolNames,
  recordAcceptedToolNames,
  resolvePlaceholderNames,
} from "./opencodeToolObservation.js";

const OPENCODE_FREE_MODELS = new Set([
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
]);
const PLACEHOLDER_TOOL_NAME = "_noop";
const PLACEHOLDER_TOOL_DESCRIPTION = "Do not call this tool. It exists only for API compatibility and must never be invoked.";
const PLACEHOLDER_TOOL_PARAMETERS = { type: "object", properties: {} };
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export function isPremiumOpencodeModel(model, provider) {
  if (provider === "opencode-go") return true;
  if (model.endsWith("-free")) return false;
  return !OPENCODE_FREE_MODELS.has(model);
}

export function surfaceFromBaseUrl(baseUrl) {
  if (baseUrl === "https://opencode.ai/zen/v1") return "zen";
  if (baseUrl === "https://opencode.ai/zen/go/v1") return "go";
  return "other";
}

export function isGatedFreeTierRequest(surface, provider, model) {
  return surface === "zen" && !isPremiumOpencodeModel(model, provider);
}

export function requiresFreeTierRequestContract(surface, provider, model) {
  return isGatedFreeTierRequest(surface, provider, model)
    && (process.env.OPENCODE_FREE_TIER_REQUEST_CONTRACT || "").trim().toLowerCase() !== "off";
}

export function configuredPlaceholderToolNames() {
  const kept = [];
  for (const part of (process.env.OPENCODE_FREE_TIER_PLACEHOLDER_TOOLS || "").split(",")) {
    const name = part.trim();
    if (kept.length >= 32) break;
    if (!NAME_PATTERN.test(name)) continue;
    if (!kept.includes(name)) kept.push(name);
  }
  return kept;
}

function hasTools(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

export function applyFreeTierRequestContract(body, requestFormat, placeholderNames = [PLACEHOLDER_TOOL_NAME]) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const next = { ...body, stream: true };
  if (hasTools(next)) return next;
  const names = placeholderNames.length > 0 ? placeholderNames : [PLACEHOLDER_TOOL_NAME];
  if (requestFormat === "openai-responses") {
    next.tools = names.map((name) => ({
      type: "function",
      name,
      description: PLACEHOLDER_TOOL_DESCRIPTION,
      parameters: PLACEHOLDER_TOOL_PARAMETERS,
    }));
  } else if (requestFormat === "openai" || requestFormat === null) {
    next.tools = names.map((name) => ({
      type: "function",
      function: {
        name,
        description: PLACEHOLDER_TOOL_DESCRIPTION,
        parameters: PLACEHOLDER_TOOL_PARAMETERS,
      },
    }));
  }
  return next;
}

function clientToolNamesOf(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.tools)) return [];
  const names = [];
  for (const tool of body.tools) {
    if (!tool || typeof tool !== "object") continue;
    const name = typeof tool.name === "string" ? tool.name : tool.function?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}

export function prepareFreeTierRequest(body, requestFormat, surface, provider, model, session) {
  const clientToolNames = clientToolNamesOf(body);
  if (!requiresFreeTierRequestContract(surface, provider, model)) return { body, attempt: null };
  const names = resolvePlaceholderNames(provider, model, session, configuredPlaceholderToolNames());
  return {
    body: applyFreeTierRequestContract(body, requestFormat, names),
    attempt: {
      provider,
      model,
      session,
      borrowed: clientToolNames.length === 0 && names.length > 0,
      clientToolNames,
    },
  };
}

export function noteFreeTierOutcome(attempt, ok) {
  if (!attempt) return;
  if (ok) {
    if (attempt.clientToolNames.length > 0) {
      recordAcceptedToolNames(attempt.provider, attempt.model, attempt.session, attempt.clientToolNames);
    }
  } else if (attempt.borrowed) {
    noteRefusedBorrowedToolNames(attempt.provider, attempt.model, attempt.session);
  }
}

export function rebuildJsonFromForcedStream(response, requestFormat, model) {
  if (!response.ok || !response.body) return response;
  if (!(response.headers.get("content-type") || "").includes("text/event-stream")) return response;

  const upstream = response;
  let drained = false;
  const body = new ReadableStream({
    async pull(controller) {
      if (drained) {
        controller.close();
        return;
      }
      drained = true;
      try {
        let parsed;
        let rawSse = "";
        if (requestFormat === "openai-responses") {
          parsed = await convertResponsesStreamToJson(upstream.body);
        } else {
          rawSse = await upstream.text();
          parsed = parseSSEToOpenAIResponse(rawSse, model);
        }
        const output = parsed && typeof parsed === "object" ? JSON.stringify(parsed) : rawSse;
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      if (!drained && !upstream.body.locked) return upstream.body.cancel(reason);
    },
  }, { highWaterMark: 0 });
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
