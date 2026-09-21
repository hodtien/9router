const FREE_TIER_SIGNALS = ["freetiererror", "free tier can only be used"];
const GEO_SIGNALS = [
  "not available in your country",
  "not available in your region",
  "unsupported_country",
  "unsupported country",
];
const REGION_ERROR_RE = /(?<![A-Za-z0-9_-])regionerror(?![A-Za-z0-9_-])/i;
const CLOUDFLARE_1010_RE = /(?<![A-Za-z0-9_-])error[\s_-]?code[\\"':=\s]{0,12}1010(?!\w)|(?<![A-Za-z0-9_-])error[-_]\s?1010(?!\w)\/?/i;

function isFingerprintRejection(bodyText) {
  const text = String(bodyText || "");
  const lower = text.toLowerCase();
  return CLOUDFLARE_1010_RE.test(text)
    || lower.includes("browser_signature_banned")
    || lower.includes("fingerprint_rejection");
}

export function isOpencodeGeoBlocked(status, bodyText) {
  if (Number(status) !== 403 && Number(status) !== 451) return false;
  const text = String(bodyText || "");
  if (isFingerprintRejection(text)) return false;
  const lower = text.toLowerCase();
  return REGION_ERROR_RE.test(text) || GEO_SIGNALS.some((signal) => lower.includes(signal));
}

export function isOpencodeUserBlocked(status, bodyText) {
  if (Number(status) !== 403 && Number(status) !== 451) return false;
  return String(bodyText || "").toLowerCase().includes("user_blocked");
}

export function isOpencodeFreeTierRefusal(status, bodyText) {
  if (Number(status) !== 403 && Number(status) !== 451) return false;
  const text = String(bodyText || "");
  if (isFingerprintRejection(text)
    || isOpencodeGeoBlocked(status, text)
    || isOpencodeUserBlocked(status, text)) return false;
  const lower = text.toLowerCase();
  return FREE_TIER_SIGNALS.some((signal) => lower.includes(signal));
}

export function isOpencodeFreeTierRefusalForProvider(provider, status, bodyText) {
  return String(provider || "").toLowerCase().startsWith("opencode")
    && isOpencodeFreeTierRefusal(status, bodyText);
}

export function isOpencodeFreeTierRateLimitForProvider(provider, status, bodyText) {
  if (!String(provider || "").toLowerCase().startsWith("opencode")) return false;
  if (Number(status) !== 429) return false;
  try {
    const parsed = typeof bodyText === "string" ? JSON.parse(bodyText) : bodyText;
    const type = parsed?.type || parsed?.error?.type;
    return type === "FreeUsageLimitError" || type === "FreeTierError";
  } catch {
    return /FreeUsageLimitError|FreeTierError/i.test(String(bodyText || ""));
  }
}
