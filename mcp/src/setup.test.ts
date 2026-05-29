import { describe, expect, it } from "vitest";

import { guardVaultProvision, normalizeGitRemote } from "./setup.js";

/**
 * Story 10.13 — Setup-Guard idempotency (AC#3).
 *
 * `guardVaultProvision` is the pure, DB-free idempotency check the vault
 * provisioning paths should consult before inserting a `vaults` row. It must
 * tell a duplicate (reuse) apart from a genuinely new vault (create).
 */

describe("normalizeGitRemote", () => {
  it("strips trailing slash, .git suffix, and lowercases", () => {
    expect(normalizeGitRemote("https://Forgejo.Example.com/oliver/Vault.git/")).toBe(
      "https://forgejo.example.com/oliver/vault",
    );
  });

  it("treats cosmetic variants as equal", () => {
    expect(normalizeGitRemote("https://h/o/v")).toBe(normalizeGitRemote("https://H/o/v.git"));
    expect(normalizeGitRemote("https://h/o/v")).toBe(normalizeGitRemote("https://h/o/v/"));
  });
});

describe("guardVaultProvision — reuse vs create (AC#3)", () => {
  const existing = [
    { id: "01EXISTING", slug: "personal-abc12345", gitRemote: "https://forgejo/oliver/mein-vault" },
  ];

  it("reuses when the slug already exists (DB unique key)", () => {
    const d = guardVaultProvision(existing, {
      slug: "personal-abc12345",
      gitRemote: "https://forgejo/oliver/other",
    });
    expect(d).toEqual({ action: "reuse", vaultId: "01EXISTING", reason: "slug" });
  });

  it("reuses when the git-remote matches (same logical vault, different slug)", () => {
    const d = guardVaultProvision(existing, {
      slug: "a-different-slug",
      gitRemote: "https://forgejo/oliver/mein-vault.git/", // cosmetic diff only
    });
    expect(d).toEqual({ action: "reuse", vaultId: "01EXISTING", reason: "git-remote" });
  });

  it("creates when neither slug nor git-remote match", () => {
    const d = guardVaultProvision(existing, {
      slug: "brand-new",
      gitRemote: "https://forgejo/oliver/totally-new",
    });
    expect(d).toEqual({ action: "create" });
  });

  it("does NOT match on empty git-remote (auto-provision leaves it blank)", () => {
    // auth.ts autoProvisionPersonalVault inserts gitRemote: "" — an empty
    // remote must never collapse two distinct empty-remote vaults into one.
    const withEmpty = [{ id: "01A", slug: "personal-x", gitRemote: "" }];
    const d = guardVaultProvision(withEmpty, { slug: "personal-y", gitRemote: "" });
    expect(d).toEqual({ action: "create" });
  });

  it("creates against an empty DB", () => {
    const d = guardVaultProvision([], { slug: "first", gitRemote: "https://h/o/v" });
    expect(d).toEqual({ action: "create" });
  });
});
