import { describe, it, expect } from "vitest";
import { isLegacyBearer } from "./httpServer.js";

/**
 * Story 7.10 — the legacy env-token comparison.
 *
 * An installation may now run WITHOUT `LOKYY_MCP_TOKEN` and authenticate purely
 * via DB-backed tokens (Einstellungen → MCP). That makes the empty-string case
 * a security boundary, not a curiosity: a bare `Authorization: Bearer ` header
 * yields `""`, which must never match an unset env token.
 */
describe("isLegacyBearer", () => {
  it("matches only when both sides are the same non-empty value", () => {
    expect(isLegacyBearer("s3cret", "s3cret")).toBe(true);
    expect(isLegacyBearer("s3cret", "other")).toBe(false);
  });

  it("never matches when the env token is unset (DB-token-only install)", () => {
    expect(isLegacyBearer("", "")).toBe(false);
    expect(isLegacyBearer(undefined, "")).toBe(false);
    expect(isLegacyBearer("", undefined)).toBe(false);
    expect(isLegacyBearer("anything", "")).toBe(false);
  });

  it("never matches a missing Authorization header", () => {
    expect(isLegacyBearer(undefined, "s3cret")).toBe(false);
    expect(isLegacyBearer("", "s3cret")).toBe(false);
  });
});
