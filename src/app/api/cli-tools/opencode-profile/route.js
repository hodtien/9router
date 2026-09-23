import { NextResponse } from "next/server";
import { getProviderCredentials } from "@/sse/services/auth.js";
import {
  getOpenCodeProfileStatus,
  refreshOpenCodeProfile,
} from "@/lib/opencodeProfile.js";

function proxyOptionsFromCredentials(credentials) {
  const data = credentials?.providerSpecificData || {};
  return {
    connectionProxyEnabled: data.connectionProxyEnabled === true,
    connectionProxyUrl: data.connectionProxyUrl || "",
    connectionNoProxy: data.connectionNoProxy || "",
    connectionProxyPoolId: data.connectionProxyPoolId || null,
    strictProxy: data.strictProxy === true,
    vercelRelayUrl: data.vercelRelayUrl || "",
  };
}

async function resolveProxyOptions() {
  const credentials = await getProviderCredentials("opencode");
  if (!credentials || credentials.allRateLimited) return null;
  return proxyOptionsFromCredentials(credentials);
}

export async function GET() {
  try {
    const proxyOptions = await resolveProxyOptions();
    if (!proxyOptions) {
      return NextResponse.json({ state: "unavailable", proxy: "unknown", handoff: "unverified" });
    }
    return NextResponse.json(await getOpenCodeProfileStatus({ proxyOptions }));
  } catch (error) {
    console.warn("[OpenCode profile] status failed:", error.message);
    return NextResponse.json({ state: "failed", proxy: "unknown", handoff: "unverified" }, { status: 500 });
  }
}

export async function POST() {
  try {
    const proxyOptions = await resolveProxyOptions();
    if (!proxyOptions) {
      return NextResponse.json({ state: "unavailable", proxy: "unknown", handoff: "unverified" }, { status: 503 });
    }
    const result = await refreshOpenCodeProfile({ proxyOptions });
    return NextResponse.json(result, { status: result.state === "failed" ? 502 : 200 });
  } catch (error) {
    console.warn("[OpenCode profile] refresh failed:", error.message);
    return NextResponse.json({ state: "failed", proxy: "unknown", handoff: "unverified" }, { status: 500 });
  }
}
