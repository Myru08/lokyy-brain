import { describe, it, expect } from "vitest";
import {
  hashMcpToken,
  generateMcpToken,
  MCP_TOKEN_PREFIX,
  SHARED_DEFAULT_MCP_TOKEN,
  isSharedDefaultMcpToken,
} from "./tokens.js";

/**
 * Pure (DB-free) guards around the token primitives. The DB-bound lifecycle
 * (create → lookup → revoke) is covered by `server/src/routes/mcpTokens.test.ts`
 * behind `LOKYY_TEST_DATABASE_URL`.
 */
describe("mcp token primitives", () => {
  it("mints prefixed, unique, high-entropy bearers", () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
    // 32 random bytes → 43 base64url chars on top of the prefix.
    expect(a.length).toBeGreaterThan(MCP_TOKEN_PREFIX.length + 40);
  });

  it("hashes to a stable 64-char sha256 hex that is not the plaintext", () => {
    const raw = generateMcpToken();
    const hash = hashMcpToken(raw);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashMcpToken(raw));
    expect(hash).not.toContain(raw);
  });

  // Story 7.10 AC#7: the shared default shipped in docker-compose.local.yml is
  // still ACCEPTED (existing installs must keep working) but has to be
  // detectable so the UI can flag it as insecure.
  it("recognises the shared public default token", () => {
    expect(SHARED_DEFAULT_MCP_TOKEN).toBe(
      "local_dev_token_change_me_32_chars_min",
    );
    expect(isSharedDefaultMcpToken(SHARED_DEFAULT_MCP_TOKEN)).toBe(true);
    expect(isSharedDefaultMcpToken("  " + SHARED_DEFAULT_MCP_TOKEN + " ")).toBe(
      true,
    );
    expect(isSharedDefaultMcpToken(generateMcpToken())).toBe(false);
    expect(isSharedDefaultMcpToken("")).toBe(false);
    expect(isSharedDefaultMcpToken(undefined)).toBe(false);
  });
});
