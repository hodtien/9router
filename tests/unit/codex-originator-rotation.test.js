/**
 * Codex originator per-account rotation.
 *
 * OpenAI fingerprints Codex clients via the `originator` header. With 50 OAuth
 * connections routed through one process, sending the same `codex_cli_rs` for
 * every request collapses them into a single client and triggers OpenAI's
 * reuse-detection revokes. We rotate the suffix per `chatgptAccountId` (with
 * `workspaceId` / `accountId` fallbacks) so each account looks like its own
 * Codex CLI instance.
 *
 * Lock in: suffix shape, workspaceId priority, no-account-id fallback.
 */

import { describe, expect, it } from "vitest";

import { CodexExecutor } from "../../open-sse/executors/codex.js";

function buildCreds(providerSpecificData = {}) {
  return {
    accessToken: "tok",
    refreshToken: "rt",
    connectionId: "conn-test",
    providerSpecificData,
  };
}

describe("Codex buildHeaders — per-account originator", () => {
  it("appends the chatgptAccountId prefix when present", () => {
    const headers = new CodexExecutor().buildHeaders(
      buildCreds({ chatgptAccountId: "deada48a-9b73-4d45-bafc-ed37b5c4c44a" }),
      true,
    );
    // First 8 chars of the account id; full id also stays in ChatGPT-Account-ID.
    expect(headers["originator"]).toBe("codex_cli_rs/deada48a");
    expect(headers["ChatGPT-Account-ID"]).toBe("deada48a-9b73-4d45-bafc-ed37b5c4c44a");
  });

  it("prefers workspaceId over chatgptAccountId for the suffix and binding header", () => {
    const headers = new CodexExecutor().buildHeaders(
      buildCreds({
        workspaceId: "ws-deadbeef-0000",
        chatgptAccountId: "account-1111",
        accountId: "shrug",
      }),
      true,
    );
    expect(headers["originator"]).toBe("codex_cli_rs/ws-deadb");
    expect(headers["ChatGPT-Account-ID"]).toBe("ws-deadbeef-0000");
  });

  it("falls back to bare codex_cli_rs when no account id is available", () => {
    const headers = new CodexExecutor().buildHeaders(
      buildCreds({}),
      true,
    );
    expect(headers["originator"]).toBe("codex_cli_rs");
    expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
  });

  it("always overwrites the transport registry's static originator", () => {
    // super.buildHeaders spreads this.config.headers including
    // `originator: "codex_cli_rs"` from registry/codex.js. We must rotate on
    // top of it for the per-account fingerprint to take effect.
    const creds = buildCreds({ chatgptAccountId: "deada48a-9b73-4d45-bafc-ed37b5c4c44a" });
    const headers = new CodexExecutor().buildHeaders(creds, true);
    expect(headers["originator"]).toBe("codex_cli_rs/deada48a");
  });
});
