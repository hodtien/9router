#!/usr/bin/env bun
/**
 * opencode-fetcher.js — Bun script that proxies a request to opencode.ai
 * using Bun's native fetch (which carries the Bun TLS fingerprint that the
 * opencode free-tier gate accepts).
 *
 * Reads input from stdin: { url, headers, body, stream, proxyUrl?, vercelRelayUrl? }
 * Writes output to stdout:
 *   - non-stream: { status, headers, body }
 *   - stream: forwards raw SSE bytes as they arrive
 *
 * Why Bun: opencode's free-tier gate fingerprints the TLS ClientHello. Node
 * fetch (undici) gets 403 even with correct headers. Bun ships its own TLS
 * stack and produces the matching signature. Spawning this script from the
 * Node executor inherits the right fingerprint without dragging Bun into the
 * rest of the gateway.
 *
 * Proxy: opencode also rate-limits per source IP (FreeUsageLimitError 429).
 * The gateway's noAuth virtual connection reads a `proxyUrl` from the active
 * provider strategy and passes it here. Bun's fetch() supports a `proxy`
 * option that uses an HTTP proxy with TLS termination at the proxy — the
 * upstream sees the proxy's egress IP, not the VPS's. This is the only way
 * to refresh the rate-limit bucket between requests.
 */

const chunks = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const { url, headers = {}, body = "", stream = false, proxyUrl, strictProxy = false, vercelRelayUrl } = input;

const relayTarget = vercelRelayUrl ? new URL(url) : null;
const requestUrl = vercelRelayUrl || url;
const requestHeaders = vercelRelayUrl
  ? {
    ...headers,
    "x-relay-target": `${relayTarget.protocol}//${relayTarget.host}`,
    "x-relay-path": `${relayTarget.pathname}${relayTarget.search}`,
  }
  : headers;
const requestInit = {
  method: "POST",
  headers: requestHeaders,
  body,
};
if (proxyUrl && !vercelRelayUrl) {
  // ponytail: Bun's `proxy` option accepts a URL string. We don't tunnel
  // through CONNECT (no `https` field) — opencode is HTTPS but the proxy
  // speaks plain HTTP, so Bun sends a plain HTTP request to the proxy with
  // an absolute-URI target. The proxy then opens a fresh TLS connection
  // to opencode.ai from its own IP, refreshing the rate-limit bucket.
  // Confirmed working with the Xoay / VN00 pool format:
  //   http://user:pass@host:port
  requestInit.proxy = proxyUrl;
}

if (strictProxy && !proxyUrl && !vercelRelayUrl) {
  throw new Error("OpenCode proxy is required but no proxy URL was provided");
}

if (stream) {
  // Streaming mode: forward raw bytes to stdout, exit when upstream closes.
  const resp = await fetch(requestUrl, requestInit);
  process.stdout.write(JSON.stringify({ status: resp.status, headers: Object.fromEntries(resp.headers) }) + "\n");
  if (!resp.body) {
    process.stdout.write("\n");
    process.exit(0);
  }
  const reader = resp.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    process.stdout.write(value);
  }
  process.exit(0);
}

const resp = await fetch(requestUrl, requestInit);
const text = await resp.text();
process.stdout.write(JSON.stringify({
  status: resp.status,
  headers: Object.fromEntries(resp.headers),
  body: text,
}));
process.exit(0);
