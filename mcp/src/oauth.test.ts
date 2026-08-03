import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isOAuthConfigured, issueToken, verifyToken } from "./oauth.js";

/**
 * Story 7.10 — OAuth must be OFF when it is not configured.
 *
 * Since an installation may now run with NO `LOKYY_MCP_TOKEN` (DB-backed tokens
 * only), both OAuth secrets can end up empty. The signing secret would then
 * collapse to the constant `"derived:"` — a value anyone can read in this repo —
 * and every forged JWT would verify. These tests pin the gate that prevents it.
 */

const KEYS = [
  "LOKYY_MCP_TOKEN",
  "LOKYY_OAUTH_PASSWORD",
  "LOKYY_OAUTH_SIGNING_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("isOAuthConfigured", () => {
  it("is false with no env configuration at all", () => {
    expect(isOAuthConfigured()).toBe(false);
  });

  it("is false when only one half is configured", () => {
    process.env.LOKYY_OAUTH_SIGNING_SECRET = "s3cret";
    expect(isOAuthConfigured()).toBe(false);
    delete process.env.LOKYY_OAUTH_SIGNING_SECRET;
    process.env.LOKYY_OAUTH_PASSWORD = "pw";
    expect(isOAuthConfigured()).toBe(false);
  });

  it("is true via the legacy LOKYY_MCP_TOKEN fallback (unchanged behaviour)", () => {
    process.env.LOKYY_MCP_TOKEN = "legacy-token";
    expect(isOAuthConfigured()).toBe(true);
  });
});

describe("verifyToken", () => {
  it("rejects a token forged with the well-known derived secret when unconfigured", () => {
    // Mint while "configured" with the empty-derived secret …
    process.env.LOKYY_MCP_TOKEN = "";
    process.env.LOKYY_OAUTH_SIGNING_SECRET = "";
    const forged = issueToken("https://brain.example", "access");
    // … then verify in the real unconfigured state.
    delete process.env.LOKYY_MCP_TOKEN;
    delete process.env.LOKYY_OAUTH_SIGNING_SECRET;
    expect(verifyToken(forged, "access")).toBe(false);
  });

  it("still accepts a properly signed token when configured", () => {
    process.env.LOKYY_OAUTH_SIGNING_SECRET = "a-real-secret";
    process.env.LOKYY_OAUTH_PASSWORD = "a-real-password";
    const token = issueToken("https://brain.example", "access");
    expect(verifyToken(token, "access")).toBe(true);
    expect(verifyToken(token, "refresh")).toBe(false);
  });
});
