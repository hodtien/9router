import { NextResponse } from "next/server";
import { getProviderCredentials } from "@/sse/services/auth.js";
import { getOpenCodeProfileStatus } from "@/lib/opencodeProfile.js";
import { recoverOpenCodeProfile } from "@/lib/opencodeProfileRecovery.js";

const PROFILE_STATUS_KEYS = ["state", "proxy", "handoff", "updatedAt", "probeStage", "upstreamClass"];

function safeProfileStatus(value = {}) {
  return Object.fromEntries(PROFILE_STATUS_KEYS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => [key, value[key]]));
}

function proxyOptionsFromCredentials(credentials) {
  const data = credentials?.providerSpecificData || {};
  return {
    connectionProxyEnabled: data.connectionProxyEnabled === true,
    connectionProxyUrl: data.connectionProxyUrl || "",
    connectionNoProxy: data.connectionNoProxy || "",
    connectionProxyPoolId: data.connectionProxyPoolId || null,
    connectionId: credentials?.connectionId ?? credentials?.id ?? null,
    connectionName: credentials?.connectionName ?? null,
    strictProxy: data.strictProxy === true,
    vercelRelayUrl: data.vercelRelayUrl || "",
  };
}

async function resolveCredentials() {
  const credentials = await getProviderCredentials("opencode");
  if (!credentials || credentials.allRateLimited) return null;
  return { credentials, proxyOptions: proxyOptionsFromCredentials(credentials) };
}

export async function GET() {
  try {
    const resolved = await resolveCredentials();
    if (!resolved) {
      return NextResponse.json({ state: "unavailable", proxy: "unknown", handoff: "unverified" });
    }
    return NextResponse.json(safeProfileStatus(await getOpenCodeProfileStatus({ proxyOptions: resolved.proxyOptions })));
  } catch {
    console.warn("[OpenCode profile] status failed");
    return NextResponse.json({ state: "failed", proxy: "unknown", handoff: "unverified" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const resolved = await resolveCredentials();
    if (!resolved) {
      return NextResponse.json({ state: "unavailable", proxy: "unknown", handoff: "unverified" }, { status: 503 });
    }
    const result = await recoverOpenCodeProfile(resolved);
    if (result.state === "ready" && result.handoff === "verified") return NextResponse.json(safeProfileStatus(result));
    const status = result.state === "cooldown" ? 429
      : ["unsupported", "proxy-not-supported", "proxy-not-strict", "direct-egress"].includes(result.state) ? 501
        : 502;
    return NextResponse.json(safeProfileStatus(result), { status });
  } catch {
    console.warn("[OpenCode profile] refresh failed");
    return NextResponse.json({ state: "failed", proxy: "unknown", handoff: "unverified" }, { status: 502 });
  }
}
