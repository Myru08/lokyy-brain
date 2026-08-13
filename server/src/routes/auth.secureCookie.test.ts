import { describe, expect, it } from "vitest";

/**
 * Issue #39 (Hardening) — the session cookie's `secure` flag is env-driven.
 *
 * Derivation (see resolveCookieSecure in ./auth.ts):
 *   - explicit LOKYY_COOKIE_SECURE=true|false wins over everything
 *   - otherwise secure in production (NODE_ENV === "production")
 *   - otherwise insecure, so a plain-HTTP local login keeps working
 */

// `server/src/config.ts` reads process.env at import time; the route module
// itself doesn't need it, but @lokyy/core pulls in modules that do.
process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

type AuthMod = typeof import("./auth.js");
let resolveCookieSecure: AuthMod["resolveCookieSecure"];

// Load through the module graph once; the function is pure and takes its env
// as an argument, so we never touch the ambient process.env.
const load = async () => {
  ({ resolveCookieSecure } = await import("./auth.js"));
};

describe("resolveCookieSecure", () => {
  it("defaults to false in dev (no NODE_ENV=production)", async () => {
    await load();
    expect(resolveCookieSecure({ NODE_ENV: "development" })).toBe(false);
    expect(resolveCookieSecure({})).toBe(false);
  });

  it("defaults to true in production", async () => {
    await load();
    expect(resolveCookieSecure({ NODE_ENV: "production" })).toBe(true);
  });

  it("explicit LOKYY_COOKIE_SECURE overrides the NODE_ENV default", async () => {
    await load();
    // force-on in dev (e.g. HTTPS dev proxy)
    expect(resolveCookieSecure({ NODE_ENV: "development", LOKYY_COOKIE_SECURE: "true" })).toBe(
      true,
    );
    // force-off in prod (e.g. TLS terminated but app reached over HTTP internally)
    expect(resolveCookieSecure({ NODE_ENV: "production", LOKYY_COOKIE_SECURE: "false" })).toBe(
      false,
    );
  });

  it("tolerates surrounding whitespace and casing in the override", async () => {
    await load();
    expect(resolveCookieSecure({ LOKYY_COOKIE_SECURE: "  TRUE " })).toBe(true);
    expect(resolveCookieSecure({ NODE_ENV: "production", LOKYY_COOKIE_SECURE: " False " })).toBe(
      false,
    );
  });

  it("ignores a non-boolean override and falls back to the NODE_ENV default", async () => {
    await load();
    expect(resolveCookieSecure({ NODE_ENV: "production", LOKYY_COOKIE_SECURE: "yes" })).toBe(true);
    expect(resolveCookieSecure({ NODE_ENV: "development", LOKYY_COOKIE_SECURE: "1" })).toBe(false);
  });
});
