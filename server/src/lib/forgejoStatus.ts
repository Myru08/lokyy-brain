import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  database,
  vaults,
  getValidForgejoToken,
  loadAllTokensForUser,
} from "@lokyy/core";
import { config } from "../config.js";

const exec = promisify(execFile);

/**
 * The ONE place that decides "is Forgejo reachable?".
 *
 * Story 1.17: `GET /api/admin/status` used to probe `config.gitRemote`
 * (`GIT_REMOTE`), which is intentionally empty for wizard-based installs — the
 * remote and the OAuth token live in the `vaults` row instead. The resulting
 * unauthenticated `git ls-remote --heads "" <branch>` always failed, so the
 * System tab reported Forgejo as permanently disconnected while it was working.
 *
 * Every surface that reports Forgejo connectivity (admin `/status`,
 * `/api/diagnostics`) goes through `forgejoStatus()` here and renders the SAME
 * verdict through the mappers at the bottom — agreement between the tabs is
 * structural, not a coincidence two handlers have to keep in sync by hand.
 */

export interface ForgejoTarget {
  gitRemote: string;
  gitBranch: string;
  /**
   * Vault owner whose `forgejo_oauth_tokens` row authenticates the probe.
   * `null` for legacy env-configured deployments that have no vault row —
   * those fall back to an anonymous probe.
   */
  ownerId: string | null;
}

export interface ForgejoVerdict {
  ok: boolean;
  /**
   * `info` — nothing is broken: either the probe succeeded, or no remote is
   * wired yet (pre-wizard install). `error` — a configured remote is genuinely
   * unreachable.
   */
  severity: "info" | "error";
  detail?: string;
}

/** Shape of the `vaults` row fields this module cares about. */
type VaultRemoteRow = {
  gitRemote: string | null;
  gitBranch: string | null;
  ownerId: string;
};

const NO_TARGET_DETAIL =
  "Kein Vault-Remote hinterlegt — Vault-Clone wird vom Setup-Wizard provisioniert.";

/**
 * Decide which remote the connectivity probe should use.
 *
 * The vault row wins: it is what the wizard writes and what `gitService`
 * actually pushes to. `GIT_REMOTE` is only a fallback for legacy env-only
 * deployments that never ran the wizard. Returns `null` when neither is set —
 * the "not set up yet" state, not a failure.
 */
export function pickForgejoTarget(
  vaultRow: VaultRemoteRow | undefined,
  env: { gitRemote: string; gitBranch: string },
): ForgejoTarget | null {
  if (vaultRow?.gitRemote) {
    return {
      gitRemote: vaultRow.gitRemote,
      gitBranch: vaultRow.gitBranch || env.gitBranch,
      ownerId: vaultRow.ownerId,
    };
  }
  if (env.gitRemote) {
    return { gitRemote: env.gitRemote, gitBranch: env.gitBranch, ownerId: null };
  }
  return null;
}

/** Load the active vault row and resolve it to a probe target. */
export async function resolveForgejoTarget(): Promise<ForgejoTarget | null> {
  let row: VaultRemoteRow | undefined;
  try {
    row = (await database().select().from(vaults).limit(1))[0];
  } catch {
    // A dead DB is Postgres' status to report, not Forgejo's — fall back to
    // whatever env says rather than blaming Forgejo for it.
    row = undefined;
  }
  return pickForgejoTarget(row, {
    gitRemote: config.gitRemote,
    gitBranch: config.gitBranch,
  });
}

/**
 * Probe a resolved target with `git ls-remote`, injecting the vault owner's
 * OAuth token — Forgejo rejects anonymous `ls-remote` against a private repo,
 * so reading the right remote is necessary but not sufficient.
 */
export async function checkForgejoTarget(
  target: ForgejoTarget | null,
): Promise<ForgejoVerdict> {
  if (!target) {
    return { ok: false, severity: "info", detail: NO_TARGET_DETAIL };
  }

  const host = extractHost(target.gitRemote);
  const token =
    target.ownerId && host
      ? await findOauthTokenForHost(target.ownerId, host).catch(() => null)
      : null;
  const authedUrl = token
    ? injectOauthToken(target.gitRemote, token)
    : target.gitRemote;

  try {
    await exec("git", ["ls-remote", "--heads", authedUrl, target.gitBranch], {
      timeout: 5_000,
      // Never let git block the status endpoint on an interactive credential
      // prompt — an unauthenticated private repo must fail fast, not hang.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, severity: "info" };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const safe = token ? stripTokenFromMessage(raw, token) : raw;
    return { ok: false, severity: "error", detail: safe.slice(0, 200) };
  }
}

/** Resolve + probe. The entry point every reporting surface calls. */
export async function forgejoStatus(): Promise<ForgejoVerdict> {
  return checkForgejoTarget(await resolveForgejoTarget());
}

/** Render a verdict in the `GET /api/admin/status` entry shape. */
export function toStatusEntry(verdict: ForgejoVerdict): {
  service: "forgejo";
  ok: boolean;
  severity: "info" | "error";
  error?: string;
} {
  return {
    service: "forgejo",
    ok: verdict.ok,
    severity: verdict.severity,
    ...(verdict.detail ? { error: verdict.detail } : {}),
  };
}

/** Render the same verdict in the `GET /api/diagnostics` check shape. */
export function toDiagnosticFields(verdict: ForgejoVerdict): {
  ok: boolean;
  severity: "info" | "error";
  detail?: string;
} {
  return {
    ok: verdict.ok,
    severity: verdict.severity,
    ...(verdict.detail ? { detail: verdict.detail } : {}),
  };
}

/**
 * Extract the bare host (no scheme, no path) from a clone URL.
 *
 *   https://forgejo.example.com/oliver/vault.git → "forgejo.example.com"
 *
 * Returns null for SSH/bare slugs/anything we can't parse — caller treats
 * null as "not OAuth-eligible, fall back to anonymous test".
 */
export function extractHost(gitRemote: string): string | null {
  try {
    const u = new URL(gitRemote);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.host;
  } catch {
    return null;
  }
}

/**
 * Find a `forgejo_oauth_tokens` row for `(userId, host)`.
 *
 * The token row stores `forgejo_base_url` like `https://forgejo.example.com`
 * — we match by host so an HTTPS clone URL with the same hostname picks up
 * the right token regardless of whether the stored base ends in a slash or
 * has a path suffix.
 */
export async function findOauthTokenForHost(
  userId: string,
  host: string,
): Promise<string | null> {
  const rows = await loadAllTokensForUser(userId);
  // `forgejo_base_url` is whatever the operator set in env — normalize to
  // host before comparing so trailing-slash / scheme drift doesn't matter.
  // Tokens are returned ALREADY DECRYPTED by loadAllTokensForUser, so we
  // can hand them straight to `git ls-remote`.
  for (const r of rows) {
    let tokenHost: string;
    try {
      tokenHost = new URL(r.forgejoBaseUrl).host;
    } catch {
      tokenHost = r.forgejoBaseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    }
    if (tokenHost !== host) continue;
    // Run through the refresh-token-aware helper so an expired access_token
    // gets transparently refreshed before the `git ls-remote` test runs.
    // Falls back to the directly-loaded value if the env-level OAuth-app
    // config isn't wired up (refresh impossible, but the legacy token is
    // still our best bet — let git decide whether it works).
    const fresh = await getValidForgejoToken(userId, {
      forgejoBaseUrl: r.forgejoBaseUrl,
      clientId: config.forgejoOauthClientId,
      clientSecret: config.forgejoOauthClientSecret,
    });
    return fresh ?? r.accessToken ?? null;
  }
  return null;
}

/**
 * Inject `oauth2:<token>@` into an HTTPS clone URL. Same convention
 * `setupVaultFromForgejo` uses in `gitService.ts`. Token NEVER touches the
 * stored `vaults.git_remote` column — only the in-flight `git ls-remote`
 * argument.
 */
export function injectOauthToken(gitRemote: string, accessToken: string): string {
  try {
    const u = new URL(gitRemote);
    if (u.protocol !== "https:" && u.protocol !== "http:") return gitRemote;
    return `${u.protocol}//oauth2:${accessToken}@${u.host}${u.pathname}${u.search}`;
  } catch {
    return gitRemote;
  }
}

/**
 * Remove the OAuth token from any error string before returning it to the
 * client / logs. Git tends to echo the full URL back in stderr; we never
 * want the token to surface there.
 */
export function stripTokenFromMessage(message: string, token: string): string {
  if (!token) return message;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message
    .replace(new RegExp(`oauth2:${escaped}@`, "g"), "oauth2:***@")
    .replace(new RegExp(escaped, "g"), "***");
}
