// ponytail: per-model observation cache for opencode free-tier tool fingerprint.
// PR #14013 upstream notes that the gate looks at *which* tool names we declare
// (not just the count) and that the accepted set drifts per model/day. We seed
// with the historical {bash, glob, grep, read} quartet, and let a successful
// 200 response overwrite the model's fingerprint with the tools it actually
// accepted. Three consecutive 403 FreeTierError refusals (which #14011 no
// longer treats as lockout-worthy) drop the learned set back to the default,
// so we self-heal when the upstream rotates.
//
// Module state lives in-process; the gateway is a singleton and the model set
// is small (<20), so a Map is enough. ponytail: replace with persistent cache
// (sqlite/redis) if the gateway becomes multi-process.
const DEFAULT_OPENCODE_FINGERPRINT = ["bash", "glob", "grep", "read"];

const MAX_ENTRIES = 64;
const REFUSAL_DROP_THRESHOLD = 3;

// model id → { names: string[], refusalCount: number }
const cache = new Map();

function evictIfFull() {
  if (cache.size <= MAX_ENTRIES) return;
  // ponytail: Map iteration order is insertion order; drop the oldest entry.
  // LRU would be marginally better, but the population is tiny and the cost
  // of a wrong eviction is "back to default fingerprint," which is exactly
  // what a refusal would trigger anyway.
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) cache.delete(firstKey);
}

export function resolveOpencodeToolFingerprint(model) {
  if (!model) return DEFAULT_OPENCODE_FINGERPRINT.slice();
  const entry = cache.get(model);
  if (entry?.names?.length) return entry.names.slice();
  return DEFAULT_OPENCODE_FINGERPRINT.slice();
}

export function noteOpencodeFingerprintSuccess(model, names) {
  if (!model || !Array.isArray(names) || names.length === 0) return;
  const clean = names
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter(Boolean);
  if (clean.length === 0) return;
  // ponytail: a successful response proves the upstream accepted these tool
  // names. Replace whatever was learned before and reset the refusal counter
  // — if we had been failing, it was probably with a different set.
  cache.set(model, { names: clean, refusalCount: 0 });
  evictIfFull();
}

export function noteOpencodeFingerprintRefusal(model) {
  if (!model) return;
  const entry = cache.get(model);
  if (!entry) return;
  entry.refusalCount = (entry.refusalCount || 0) + 1;
  if (entry.refusalCount >= REFUSAL_DROP_THRESHOLD) {
    cache.delete(model);
  }
}

export function _resetOpencodeFingerprintCacheForTests() {
  cache.clear();
}

export { DEFAULT_OPENCODE_FINGERPRINT };
