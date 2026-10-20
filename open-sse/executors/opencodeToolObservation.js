const MAX_NAMES_PER_ENTRY = 32;
const MAX_ENTRIES = 64;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const REFUSALS_BEFORE_FORGETTING = 3;

const observed = new Map();
const consecutiveRefusals = new Map();

function keyOf(provider, model, session) {
  return [provider, model, session ?? ""].join("|");
}

function sanitize(names) {
  const kept = [];
  for (const raw of names) {
    if (kept.length >= MAX_NAMES_PER_ENTRY) break;
    if (typeof raw !== "string" || !NAME_PATTERN.test(raw)) continue;
    if (!kept.includes(raw)) kept.push(raw);
  }
  return kept;
}

export function recordAcceptedToolNames(provider, model, session, names) {
  const kept = sanitize(names);
  if (kept.length === 0) return;
  const frozen = Object.freeze(kept);
  const keys = session
    ? [keyOf(provider, model, session), keyOf(provider, model)]
    : [keyOf(provider, model)];
  for (const key of keys) {
    observed.delete(key);
    observed.set(key, frozen);
    consecutiveRefusals.delete(key);
  }
  while (observed.size > MAX_ENTRIES) {
    const oldest = observed.keys().next();
    if (oldest.done) break;
    observed.delete(oldest.value);
    consecutiveRefusals.delete(oldest.value);
  }
}

export function noteRefusedBorrowedToolNames(provider, model, session) {
  const sessionKey = keyOf(provider, model, session);
  const key = observed.has(sessionKey) ? sessionKey : keyOf(provider, model);
  if (!observed.has(key)) return;
  const streak = (consecutiveRefusals.get(key) ?? 0) + 1;
  if (streak < REFUSALS_BEFORE_FORGETTING) {
    consecutiveRefusals.set(key, streak);
    return;
  }
  observed.delete(key);
  consecutiveRefusals.delete(key);
}

export function getObservedToolNames(provider, model, session) {
  return observed.get(keyOf(provider, model, session)) ?? null;
}

export function resolvePlaceholderNames(provider, model, session, configured) {
  const own = session ? getObservedToolNames(provider, model, session) : null;
  return own ?? getObservedToolNames(provider, model) ?? configured;
}

export function _resetToolObservationForTests() {
  observed.clear();
  consecutiveRefusals.clear();
}
