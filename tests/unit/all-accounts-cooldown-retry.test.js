import { describe, expect, it } from "vitest";
import { planCooldownRetry } from "../../open-sse/services/accountFallback.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

describe("planCooldownRetry", () => {
  it("waits when the earliest unlock falls inside the budget", () => {
    const retryAfter = new Date(NOW + 8_000).toISOString();
    expect(planCooldownRetry(retryAfter, 30_000, NOW)).toBe(8_000);
  });

  it("does not wait when the unlock is beyond the budget", () => {
    const retryAfter = new Date(NOW + 120_000).toISOString();
    expect(planCooldownRetry(retryAfter, 30_000, NOW)).toBe(0);
  });

  it("does not wait when the account is already unlocked", () => {
    const retryAfter = new Date(NOW - 5_000).toISOString();
    expect(planCooldownRetry(retryAfter, 30_000, NOW)).toBe(0);
  });

  it("does not wait when the pool reports no unlock time", () => {
    expect(planCooldownRetry(null, 30_000, NOW)).toBe(0);
    expect(planCooldownRetry("not-a-date", 30_000, NOW)).toBe(0);
  });

  it("does not wait when the budget is disabled", () => {
    const retryAfter = new Date(NOW + 1_000).toISOString();
    expect(planCooldownRetry(retryAfter, 0, NOW)).toBe(0);
  });
});