// Regression for the Kiro CONTENT_LENGTH_EXCEEDS_THRESHOLD bug. Earlier this
// fell through to the default transient cooldown and locked the account for 30s
// — pointless, since every account rejects the same oversized request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFallbackError } from "./accountFallback.js";

test("terminal content-length error does not fallback", () => {
  const r = checkFallbackError(
    400,
    '{"message":"Input content length exceeds threshold.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}',
    0,
  );
  assert.equal(r.shouldFallback, false);
  assert.equal(r.cooldownMs, 0);
});

test("terminal pattern matches case-insensitively", () => {
  assert.equal(
    checkFallbackError(400, "INPUT IS TOO LONG for this model", 0).shouldFallback,
    false,
  );
});

test("non-terminal 400 still falls back (auth-like errors)", () => {
  const r = checkFallbackError(401, "Invalid API key", 0);
  assert.equal(r.shouldFallback, true);
});

test("rate-limit text still triggers exponential backoff", () => {
  const r = checkFallbackError(429, "rate limit exceeded", 0);
  assert.equal(r.shouldFallback, true);
  assert.ok(r.cooldownMs >= 2000);
});

test("terminal takes precedence over a matching text rule", () => {
  // Without terminal handling, "capacity" would trigger backoff. Terminal
  // must win because content-length overflow is a request-shape error.
  const r = checkFallbackError(
    400,
    "capacity problem: input content length exceeds threshold",
    0,
  );
  assert.equal(r.shouldFallback, false);
});
