#!/usr/bin/env node
/**
 * opencode-fetcher.mjs — Node.js native fetch proxy to opencode.ai.
 *
 * Why this exists alongside _opencode-fetcher.js (Bun):
 *   opencode's free-tier gate fingerprints TLS ClientHello. Bun's fetch and
 *   Node's undici produce different fingerprints, and the upstream rate-limits
 *   each bucket separately. When Bun's bucket gets rate-limited (FreeUsageLimitError),
 *   spawning this Node-native variant often bypasses the block.
 *
 * Reads stdin: { url, headers, body, stream, proxyUrl? }
 * Writes stdout:
 *   - non-stream: { status, headers, body }
 *   - stream: header line as JSON + raw SSE bytes
 *
 * proxyUrl: when the noauth virtual connection's resolvedProxy provides a
 * pool URL, route both the Bun and the Node paths through it. Node fetch
 * honors the standard HTTPS_PROXY env var (no undici dep needed, since the
 * Next standalone bundle strips node_modules/undici). Bun uses its own
 * `proxy` option in fetch().
 */

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { url, headers = {}, body = "", stream = false, proxyUrl } = input;

const finalHeaders = { ...headers };
if (!finalHeaders["User-Agent"] && !finalHeaders["user-agent"]) {
  finalHeaders["user-agent"] = "opencode/1.18.31 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14";
}

// ponytail: Node fetch honors HTTPS_PROXY automatically. Setting it before
// the fetch call is enough — no dispatcher plumbing. The Next standalone
// build strips undici, so we can't use ProxyAgent directly.
if (proxyUrl) {
  process.env.HTTPS_PROXY = proxyUrl;
  process.env.HTTP_PROXY = proxyUrl;
}

if (stream) {
  const resp = await fetch(url, { method: "POST", headers: finalHeaders, body });
  process.stdout.write(JSON.stringify({ status: resp.status, headers: Object.fromEntries(resp.headers) }) + "\n");
  if (!resp.body) process.exit(0);
  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stdout.write(value);
  }
  process.exit(0);
}

const resp = await fetch(url, { method: "POST", headers: finalHeaders, body });
const text = await resp.text();
process.stdout.write(JSON.stringify({
  status: resp.status,
  headers: Object.fromEntries(resp.headers),
  body: text,
}));
process.exit(0);
