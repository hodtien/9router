/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  const eventMatch = msg.match(/^event:\s*(.+)$/m);
  const dataMatch = msg.match(/^data:\s*(.+)$/m);
  if (!eventMatch || !dataMatch) return;

  const eventType = eventMatch[1].trim();
  const dataStr = dataMatch[1].trim();
  if (dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch {
    if (eventType === "error") {
      state.status = "failed";
      state.terminalResponse = null;
    }
    return;
  }
  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "response.completed" || eventType === "response.done") {
    const status = parsed.response?.status;
    const output = parsed.response?.output;
    const hasOutput = Array.isArray(output) && output.length > 0
      && output.every((item) => item && typeof item === "object");
    const hasValidItems = state.items.size > 0 && [...state.items.values()].every((item) => item && typeof item === "object");
    const successfulStatus = (status === "completed" || (!status && eventType === "response.completed"))
      && (hasOutput || hasValidItems);
    if (successfulStatus && hasOutput) state.terminalResponse = parsed.response;
    else state.terminalResponse = null;
    state.status = successfulStatus ? "completed" : "incomplete";
    if (parsed.response?.usage) {
      state.usage.input_tokens = parsed.response.usage.input_tokens || 0;
      state.usage.output_tokens = parsed.response.usage.output_tokens || 0;
      state.usage.total_tokens = parsed.response.usage.total_tokens || 0;
    }
  } else if (eventType === "response.failed") {
    state.status = "failed";
    state.terminalResponse = null;
  } else if (eventType === "error") {
    state.status = "failed";
    state.terminalResponse = null;
  }
}

const EMPTY_RESPONSE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response
 * @param {ReadableStream} stream - SSE stream from provider
 * @param {{ maxBytes?: number }} options - Optional limit for bounded internal probes
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream, { maxBytes = Infinity, timeoutMs = 0 } = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", output: [], usage: { ...EMPTY_RESPONSE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let timer;
  let timedOut = false;

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: "in_progress",
    usage: { ...EMPTY_RESPONSE },
    items: new Map(),
  };

  try {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        reader.cancel(new Error("Responses stream timed out")).catch(() => {});
      }, timeoutMs);
    }
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value?.byteLength || 0;
      if (totalBytes > maxBytes) throw new Error("Responses stream exceeded limit");
      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with \n\n)
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
    if (timedOut) throw new Error("Responses stream timed out");
    if (state.status === "in_progress") state.status = "incomplete";
  } catch (error) {
    try { await reader.cancel(error); } catch { /* keep the original read error */ }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }

  if (state.status === "completed" && state.terminalResponse) return state.terminalResponse;

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  return {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "incomplete",
    output,
    usage: state.usage,
  };
}
