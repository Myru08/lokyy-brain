import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  database,
  systemConfig,
  vaults,
  initCore,
  getIntegrationSettings,
  setSupadataApiKey,
  setDefaultImportFolder,
  maskSupadataKey,
  listSkillNotes,
  parseFrontmatter,
  VAULT_HOOKS_DIR,
  createMcpToken,
  listMcpTokens,
  revokeMcpToken,
  isSharedDefaultMcpToken,
  type McpRole,
} from "@lokyy/core";
import { scaffoldVault } from "../setup/scaffoldVault.js";
import { scanVaultCompliance } from "../setup/vaultCompliance.js";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { config } from "../config.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  extractHost,
  findOauthTokenForHost,
  forgejoStatus,
  injectOauthToken,
  stripTokenFromMessage,
  toStatusEntry,
} from "../lib/forgejoStatus.js";


const exec = promisify(execFile);

export const adminRoutes = new Hono();

// Operator-only: system settings, vault re-clone, skill mgmt, etc.
adminRoutes.use("*", requireAdmin);

// GET /api/admin/system-settings — current state
//
// The Supadata key is NEVER returned in full — only a `***...{last4}` mask.
// PUT /system-settings/integrations accepts the plain value.
adminRoutes.get("/system-settings", async (c) => {
  const vaultRows = await database().select().from(vaults).limit(1);
  const v = vaultRows[0];
  const integrations = await getIntegrationSettings();
  return c.json({
    vault: v
      ? {
          id: v.id,
          name: v.name,
          gitRemote: v.gitRemote,
          gitBranch: v.gitBranch,
        }
      : null,
    runtime: {
      vaultDir: config.vaultDir,
      databaseUrl: maskDsn(config.databaseUrl),
      ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    },
    integrations: {
      supadataApiKeyMasked: maskSupadataKey(integrations.supadataApiKey),
      supadataApiKeyConfigured: integrations.supadataApiKey !== null,
      defaultImportFolder: integrations.defaultImportFolder,
    },
  });
});

// PUT /api/admin/system-settings/integrations — set Supadata key + import folder.
//
// Body (both fields optional — only present fields are updated):
//   { supadataApiKey?: string | null, defaultImportFolder?: string | null }
//
// Empty string / null for `supadataApiKey` clears the key. Empty string / null
// for `defaultImportFolder` resets it to the default (`30_captures`).
adminRoutes.put("/system-settings/integrations", async (c) => {
  const body = await c.req.json<{
    supadataApiKey?: string | null;
    defaultImportFolder?: string | null;
  }>();

  if ("supadataApiKey" in body) {
    await setSupadataApiKey(body.supadataApiKey ?? null);
  }
  if ("defaultImportFolder" in body) {
    await setDefaultImportFolder(body.defaultImportFolder ?? null);
  }

  const integrations = await getIntegrationSettings();
  return c.json({
    ok: true,
    integrations: {
      supadataApiKeyMasked: maskSupadataKey(integrations.supadataApiKey),
      supadataApiKeyConfigured: integrations.supadataApiKey !== null,
      defaultImportFolder: integrations.defaultImportFolder,
    },
  });
});

// PUT /api/admin/system-settings/vault-url — change vault URL
//
// 1. Test new remote is reachable
// 2. DB update
// 3. Reconfigure working-copy: `git remote set-url origin <new>`
// 4. Hot-swap coreConfig so in-process gitService points at new remote
// 5. Fetch + try to integrate (best-effort) and push pending local commits
//    so existing in-flight notes land on the new remote.
adminRoutes.put("/system-settings/vault-url", async (c) => {
  const { vaultId, gitRemote, gitBranch = "main" } = await c.req.json<{
    vaultId: string;
    gitRemote: string;
    gitBranch?: string;
  }>();
  if (!vaultId || !gitRemote) {
    return c.json({ error: "vaultId and gitRemote required" }, 400);
  }

  // ── 1. Remote reachability ─────────────────────────────────────────────
  //
  // Forgejo with REQUIRE_SIGNIN_VIEW rejects anonymous `git ls-remote` even
  // for public-looking URLs. The canonical (untokenised) URL is what the DB
  // stores, but the test request has to inject the OAuth token from the
  // vault owner's `forgejo_oauth_tokens` row — same pattern that
  // `setupVaultFromForgejo` uses for the initial clone.
  //
  // Token never leaks: it lives only in the authedUrl passed to `git
  // ls-remote`. The stored URL stays canonical. Any error message coming
  // back from git is sanitised before being returned to the client.
  const vaultRow = (
    await database().select().from(vaults).where(eq(vaults.id, vaultId)).limit(1)
  )[0];
  if (!vaultRow) {
    return c.json({ error: "vault-not-found" }, 404);
  }

  const candidateHost = extractHost(gitRemote);
  const oauthToken = candidateHost
    ? await findOauthTokenForHost(vaultRow.ownerId, candidateHost)
    : null;
  const authedUrl = oauthToken ? injectOauthToken(gitRemote, oauthToken) : gitRemote;
  const tokenWasInjected = authedUrl !== gitRemote;

  try {
    await exec("git", ["ls-remote", "--heads", authedUrl, gitBranch], {
      timeout: 10_000,
    });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    // Strip the token before returning — even though we built the authed
    // URL locally, git's stderr can echo the full URL back.
    const safeMessage = oauthToken
      ? stripTokenFromMessage(rawMessage, oauthToken)
      : rawMessage;
    const hint =
      !tokenWasInjected && candidateHost
        ? " Hostname not connected via OAuth. Verbinde dich erst in Schritt 1 des Setup-Wizards."
        : "";
    return c.json(
      {
        error: "remote-unreachable",
        message: safeMessage + hint,
      },
      400,
    );
  }

  // ── 2. DB update ───────────────────────────────────────────────────────
  await database()
    .update(vaults)
    .set({ gitRemote, gitBranch })
    .where(eq(vaults.id, vaultId));

  // ── 3. Working-copy git remote swap ────────────────────────────────────
  //
  // The working-copy's `.git/config` needs the TOKENISED URL so subsequent
  // `git fetch/push origin` (stages 5/5c) can authenticate against Forgejo
  // — same as what `setupVaultFromForgejo` bakes in on the initial clone.
  // The DB column above (`vaults.git_remote`) stays canonical; only the
  // local `.git/config` carries the token. If no OAuth token is available,
  // fall through with the canonical URL and let fetch/push fail explicitly.
  const workdir = config.vaultDir;
  const remoteForWorkingCopy = authedUrl;
  const stages: { step: string; ok: boolean; message?: string }[] = [];
  try {
    await exec("git", ["-C", workdir, "remote", "set-url", "origin", remoteForWorkingCopy]);
    stages.push({ step: "remote-set-url", ok: true });
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const safeMessage = oauthToken
      ? stripTokenFromMessage(rawMessage, oauthToken)
      : rawMessage;
    stages.push({
      step: "remote-set-url",
      ok: false,
      message: safeMessage,
    });
  }

  // ── 4. Hot-swap coreConfig so in-process gitService uses the new URL ───
  initCore({
    vaultDir: config.vaultDir,
    gitRemote,
    gitBranch,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  });
  stages.push({ step: "core-config-hot-swap", ok: true });

  // ── 5. Fetch + intelligent integration ─────────────────────────────────
  //
  // `git fetch origin` uses the URL in `.git/config` — which we just set to
  // `remoteForWorkingCopy` (tokenised when available). Stderr can echo that
  // URL back on failure; every error message below is filtered through
  // `stripTokenFromMessage` before it leaves the server.
  const sanitize = (msg: string) =>
    (oauthToken ? stripTokenFromMessage(msg, oauthToken) : msg).slice(0, 300);
  try {
    await exec("git", ["-C", workdir, "fetch", "origin", gitBranch], {
      timeout: 30_000,
    });
    stages.push({ step: "fetch", ok: true });
  } catch (err) {
    stages.push({
      step: "fetch",
      ok: false,
      message: err instanceof Error ? sanitize(err.message) : String(err),
    });
  }

  // ── 5b. Rebase local commits onto new remote HEAD (3 fallbacks) ────────
  let rebaseStatus = "skipped";
  try {
    await exec(
      "git",
      ["-C", workdir, "pull", "--rebase", "--autostash", "origin", gitBranch],
      { timeout: 30_000 },
    );
    rebaseStatus = "ok";
  } catch (rebaseErr) {
    // Cleanup half-done rebase before retrying.
    await exec("git", ["-C", workdir, "rebase", "--abort"]).catch(() => {});
    const msg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
    if (/unrelated histories/i.test(msg)) {
      try {
        await exec(
          "git",
          [
            "-C",
            workdir,
            "pull",
            "--no-rebase",
            "--allow-unrelated-histories",
            "origin",
            gitBranch,
          ],
          { timeout: 30_000 },
        );
        rebaseStatus = "ok-unrelated-histories-merged";
      } catch (mergeErr) {
        await exec("git", ["-C", workdir, "merge", "--abort"]).catch(() => {});
        rebaseStatus = `fail: ${mergeErr instanceof Error ? sanitize(mergeErr.message).slice(0, 200) : "unknown"}`;
      }
    } else {
      rebaseStatus = `fail: ${sanitize(msg).slice(0, 200)}`;
    }
  }
  stages.push({ step: "pull-rebase", ok: rebaseStatus.startsWith("ok"), message: rebaseStatus });

  // ── 5c. Push (only if integration succeeded) ───────────────────────────
  if (rebaseStatus.startsWith("ok")) {
    try {
      await exec(
        "git",
        ["-C", workdir, "push", "--set-upstream", "origin", gitBranch],
        { timeout: 30_000 },
      );
      stages.push({ step: "push", ok: true });
    } catch (err) {
      stages.push({
        step: "push",
        ok: false,
        message: err instanceof Error ? sanitize(err.message) : String(err),
      });
    }
  } else {
    stages.push({
      step: "push",
      ok: false,
      message: "skipped — integration failed, see pull-rebase stage",
    });
  }

  return c.json({
    ok: true,
    vaultId,
    gitRemote,
    gitBranch,
    stages,
    note:
      "Vault-URL geändert + Working-Copy umkonfiguriert + coreConfig hot-swapped. " +
      "Falls fetch/push fehlgeschlagen sind: prüfe Auth (HTTPS Token, SSH-Key). " +
      "Bei nicht-leerem Remote mit divergenter History kann ein manueller `git pull --rebase` / `--allow-unrelated-histories` nötig sein.",
  });
});

// POST /api/admin/system-settings/reclone — nuke working copy + fresh clone from current vault git_remote.
// Use when history divergence makes pull/push hopeless.
adminRoutes.post("/system-settings/reclone", async (c) => {
  const { vaultId, confirm } = await c.req.json<{ vaultId: string; confirm?: string }>();
  if (confirm !== "yes-discard-local") {
    return c.json(
      {
        error: "confirm-required",
        message:
          "POST with body `{vaultId, confirm: 'yes-discard-local'}` to wipe the local working copy and clone fresh from the vault's git_remote.",
      },
      400,
    );
  }
  if (!vaultId) return c.json({ error: "vaultId required" }, 400);

  const v = (await database().select().from(vaults).where(eq(vaults.id, vaultId)).limit(1))[0];
  if (!v) return c.json({ error: "vault-not-found" }, 404);
  if (!v.gitRemote) return c.json({ error: "vault-has-no-git-remote" }, 400);

  const { rm } = await import("node:fs/promises");
  try {
    await rm(config.vaultDir, { recursive: true, force: true });
  } catch (err) {
    return c.json({
      error: "wipe-failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await exec(
      "git",
      ["clone", "--branch", v.gitBranch, v.gitRemote, config.vaultDir],
      { timeout: 120_000 },
    );
  } catch (err) {
    return c.json({
      error: "clone-failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  initCore({
    vaultDir: config.vaultDir,
    gitRemote: v.gitRemote,
    gitBranch: v.gitBranch,
    gitAuthorName: config.gitAuthorName,
    gitAuthorEmail: config.gitAuthorEmail,
  });
  return c.json({
    ok: true,
    vaultId,
    vaultDir: config.vaultDir,
    gitRemote: v.gitRemote,
    gitBranch: v.gitBranch,
    note: "Working-Copy verworfen und frisch geklont. coreConfig hot-swapped. Server-Restart NICHT nötig.",
  });
});

// ── Story 1.20 — Basis-Scaffold auf einen BESTEHENDEN Vault nachziehen ──────
//
// Story 1.19 scaffoldet nur beim Fresh Install. Wer vor v1.9 installiert hat,
// sitzt auf einem faktisch leeren Vault und hat nie den Pre-Commit-Hook
// bekommen. Beide Handler unten legen dieselbe `scaffoldVault()` frei, die der
// Wizard benutzt — nichts ist hier nachgebaut.
//
// Der Ablauf ist bewusst zweistufig:
//   GET  → Plan (Dry-Run, schreibt garantiert nichts) + Pre-Flight-Zählung
//   POST → Anwenden; die Hook-Aktivierung ist ein EIGENES, bestätigtes Flag
//
// Warum die Hook-Aktivierung nicht mitläuft: der Hook lehnt Commits ab, die
// Notizen ohne SPEC-Frontmatter anfassen. Bei einem migrierten Alt-Vault kann
// das viele Dateien betreffen, deshalb sieht der User erst die Zahl und
// entscheidet dann.

// GET /api/admin/vault-scaffold — was WÜRDE passieren?
adminRoutes.get("/vault-scaffold", async (c) => {
  try {
    const [plan, compliance, hooksPath] = await Promise.all([
      scaffoldVault({ dryRun: true }),
      scanVaultCompliance(),
      currentHooksPath(config.vaultDir),
    ]);
    return c.json({
      vaultDir: config.vaultDir,
      plan: { created: plan.created, skipped: plan.skipped },
      hook: {
        activated: hooksPath === VAULT_HOOKS_DIR,
        hooksPath,
        // Beide Zahlen — `blocking` ist die, die die Frage „was passiert beim
        // Einschalten?" beantwortet. Siehe setup/vaultCompliance.ts.
        scanned: compliance.scanned,
        invalid: compliance.invalid,
        blocking: compliance.blocking,
        samples: compliance.samples,
        truncated: compliance.truncated,
      },
    });
  } catch (err) {
    console.error("[admin] vault-scaffold plan failed", err);
    return c.json(
      {
        error: "scaffold-plan-failed",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

// POST /api/admin/vault-scaffold  { activateHook?: boolean }
//
// `activateHook` ist hier bewusst opt-in (der Fresh-Install-Pfad hat den
// Default `true` — dort ist der Vault leer und es gibt nichts zu blockieren).
adminRoutes.post("/vault-scaffold", async (c) => {
  const body = await c.req
    .json<{ activateHook?: boolean }>()
    .catch(() => ({}) as { activateHook?: boolean });
  const activateHook = body.activateHook === true;

  try {
    const result = await scaffoldVault({ activateHook });
    if (result.pushError) {
      // Nicht als Fehler melden: das Scaffold liegt korrekt im Working-Copy,
      // ein späterer sync holt den Push nach — dieselbe Bewertung wie im
      // Wizard-Pfad in routes/setup.ts.
      console.warn(`[admin] vault-scaffold committed locally, push failed: ${result.pushError}`);
    }
    return c.json({
      ok: true,
      created: result.created,
      skipped: result.skipped,
      committed: result.committed,
      pushed: result.pushed,
      pushError: result.pushError,
      hookActivated: result.hookActivated,
    });
  } catch (err) {
    console.error("[admin] vault-scaffold apply failed", err);
    return c.json(
      {
        error: "scaffold-failed",
        message: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

/** `core.hooksPath` des Vaults, oder null wenn ungesetzt. */
async function currentHooksPath(vaultDir: string): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", vaultDir, "config", "core.hooksPath"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// GET /api/admin/status — live health of dependencies
//
// The Forgejo probe runs through the shared `forgejoStatus()` (Story 1.17):
// it reads the remote from the `vaults` row — NOT from `GIT_REMOTE`, which is
// empty by design for wizard-based installs — and authenticates with the vault
// owner's OAuth token. `/api/diagnostics` renders the SAME verdict, so the
// System and Diagnostics tabs cannot contradict each other.
//
// Each entry carries a stable `service` key (used by the PWA to look up the
// per-service remediation hint) alongside `{ ok, error? }`. The Ollama probe
// additionally yields a derived `embeddings` entry: when Ollama is reachable
// but the `nomic-embed-text` model is absent, embeddings reports ok=false with
// an actionable message — so the Settings UI can surface
// `ollama pull nomic-embed-text` without a second round-trip. Existing fields
// (`postgres.pgvector`, `ollama.hasNomicEmbed`) are preserved unchanged.
adminRoutes.get("/status", async (c) => {
  const [forgejo, postgresStatus, ollama] = await Promise.all([
    forgejoStatus(),
    checkPostgres(config.databaseUrl),
    checkOllama(process.env.OLLAMA_HOST ?? "http://localhost:11434"),
  ]);
  const embeddings = deriveEmbeddingsStatus(ollama);
  return c.json({
    forgejo: toStatusEntry(forgejo),
    postgres: { service: "postgres", ...postgresStatus },
    ollama: { service: "ollama", ...ollama },
    embeddings,
  });
});

/**
 * Derive a dedicated embeddings-model status from the Ollama probe result.
 *
 *  - Ollama unreachable → ok=false; the operator must start Ollama first, so
 *    the message points back at the Ollama remediation.
 *  - Ollama up, model present → ok=true.
 *  - Ollama up, model missing → ok=false with the `ollama pull` hint.
 */
function deriveEmbeddingsStatus(ollama: {
  ok: boolean;
  hasNomicEmbed?: boolean;
}): { service: "embeddings"; ok: boolean; error?: string } {
  if (!ollama.ok) {
    return {
      service: "embeddings",
      ok: false,
      error: "Ollama nicht erreichbar — Embeddings-Modell nicht prüfbar",
    };
  }
  if (ollama.hasNomicEmbed) {
    return { service: "embeddings", ok: true };
  }
  return {
    service: "embeddings",
    ok: false,
    error: "Modell nomic-embed-text nicht installiert",
  };
}

// ─── Own-vault MCP tokens (Story 7.10) ──────────────────────────────────
//
// Why these live here and NOT on `/api/tenants`: the tenant routes are the
// CUSTOMER-vault surface. `GET /api/tenants` returns every provisioned customer
// vault incl. its git remote (data this page has no business fetching), and
// `POST /api/tenants/:vaultId/tokens` makes the CLIENT name the vault — a
// Settings page could then point at a customer vault by accident — and defaults
// `agentId` to `kunde-<slug>`. The three routes below are thin wrappers over the
// SAME `@lokyy/core` primitives (`listMcpTokens` / `createMcpToken` /
// `revokeMcpToken`), with the vault resolved SERVER-side to the operator's own.
// No tenant logic (provisioning, repo creation, scope globs, remote masking) is
// duplicated and the tenant API stays untouched.

/** Default writer identity for the owner's own tokens — matches `LOKYY_AGENT_ID`. */
const OWN_VAULT_AGENT_ID = "claude-code";

/**
 * Stand-in inside the `mcp-info` snippets when no env token is configured. The
 * PWA swaps it for the one-time plaintext of a freshly generated token (see
 * `tokenPlaceholder` in the `mcp-info` response) — the server itself cannot,
 * since only the SHA-256 of a token is ever stored.
 */
const MCP_TOKEN_MARKER = "DEIN-MCP-TOKEN";

/**
 * The operator's own (singleton/personal) vault row. `LOKYY_VAULT_ID` wins when
 * it points at a real row — that is the id the MCP mount itself boots with —
 * then the `personal` row, then the single/oldest row a fresh install has.
 * Mirrors the resolution order in `mcpMount.ts` / `resolveVaultId`.
 */
async function ownVaultRow(): Promise<typeof vaults.$inferSelect | null> {
  const db = database();
  if (config.lokyyVaultId) {
    const [pinned] = await db
      .select()
      .from(vaults)
      .where(eq(vaults.id, config.lokyyVaultId))
      .limit(1);
    if (pinned) return pinned;
  }
  const [personal] = await db
    .select()
    .from(vaults)
    .where(eq(vaults.kind, "personal"))
    .limit(1);
  if (personal) return personal;
  const [first] = await db.select().from(vaults).limit(1);
  return first ?? null;
}

/** Metadata projection — deliberately drops `tokenHash`, which never leaves the server. */
function tokenMetadata(t: Awaited<ReturnType<typeof listMcpTokens>>[number]) {
  return {
    id: t.id,
    agentId: t.agentId,
    role: t.role,
    label: t.label,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}

/**
 * GET /api/admin/mcp-tokens — metadata of the own vault's tokens plus the state
 * of the legacy env token. NEVER returns a plaintext bearer: only the SHA-256
 * is stored, so for existing tokens there is nothing to return (AC#2).
 */
adminRoutes.get("/mcp-tokens", async (c) => {
  const vault = await ownVaultRow();
  const envValue = process.env.LOKYY_MCP_TOKEN ?? "";
  const tokens = vault ? await listMcpTokens(vault.id) : [];
  return c.json({
    vaultId: vault?.id ?? null,
    vaultName: vault?.name ?? null,
    tokens: tokens
      .map(tokenMetadata)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    // AC#6/#7: the env path stays valid; we only report WHETHER it is set and
    // whether it is the publicly-known default. The value itself never ships.
    envToken: {
      configured: envValue.length > 0,
      shared: isSharedDefaultMcpToken(envValue),
    },
  });
});

/**
 * POST /api/admin/mcp-tokens — mint a token for the own vault. The plaintext is
 * returned EXACTLY ONCE (AC#3); it is unrecoverable afterwards. Takes effect on
 * the next request — `lookupMcpToken` runs per request, no restart (AC#4).
 */
adminRoutes.post("/mcp-tokens", async (c) => {
  const vault = await ownVaultRow();
  if (!vault) return c.json({ error: "no-vault" }, 404);
  const body = await c.req
    .json<{ label?: string; agentId?: string; role?: McpRole }>()
    .catch(() => ({}) as { label?: string; agentId?: string; role?: McpRole });
  const agentId = (body.agentId ?? "").trim() || OWN_VAULT_AGENT_ID;
  const role: McpRole = body.role === "read" ? "read" : "write";
  const { token, row } = await createMcpToken({
    vaultId: vault.id,
    agentId,
    role,
    label: (body.label ?? "").trim() || "MCP-Client",
  });
  return c.json({
    ...tokenMetadata(row),
    vaultId: vault.id,
    token, // plaintext — shown ONCE, only the hash is stored
    connector: "/mcp",
  });
});

/**
 * DELETE /api/admin/mcp-tokens/:id — revoke one of the OWN vault's tokens.
 * Soft-revoke; the next `/mcp` request with it resolves to null → 401. Ids that
 * belong to another (customer) vault 404 — this surface must never reach into
 * the tenant registry.
 */
adminRoutes.delete("/mcp-tokens/:id", async (c) => {
  const id = c.req.param("id");
  if (!id) return c.json({ error: "token id required" }, 400);
  const vault = await ownVaultRow();
  if (!vault) return c.json({ error: "no-vault" }, 404);
  const owned = (await listMcpTokens(vault.id)).some((t) => t.id === id);
  if (!owned) return c.json({ error: "not-found" }, 404);
  await revokeMcpToken(id);
  return c.json({ ok: true });
});

// GET /api/admin/mcp-info — connection info for Claude Desktop / other MCP clients (Story 1.12 + Epic 7)
//
// Liefert 4 Snippet-Varianten:
//   A) local stdio (default, läuft NUR auf diesem Rechner)
//   B) npm via npx (für andere Rechner ohne lokyy-brain checkout)
//   C) Native HTTP — empfohlen für Claude Code / Claude Desktop (kein bridge, direkter HTTP-Transport)
//   D) Legacy mcp-remote-Bridge (Fallback wenn der Client kein natives HTTP unterstützt)
adminRoutes.get("/mcp-info", async (c) => {
  const projectRoot = process.env.LOKYY_PROJECT_ROOT ?? process.cwd().replace(/\/server$/, "");
  const vaultRows = await database().select().from(vaults).limit(1);
  const v = vaultRows[0];
  const httpPort = Number(process.env.LOKYY_MCP_HTTP_PORT ?? 8788);
  // Story 7.10 AC#5: no more "edit an env file and restart" placeholder. When
  // no env token is configured the snippets carry a MARKER instead, which the
  // Settings UI substitutes with a freshly minted token the moment the operator
  // generates one (the stored token is a hash — the server can never fill this
  // in itself). `tokenPlaceholder` below tells the UI what to replace.
  const envMcpToken = process.env.LOKYY_MCP_TOKEN ?? "";
  const httpToken = envMcpToken || MCP_TOKEN_MARKER;
  const publicHost = process.env.LOKYY_PUBLIC_HOST ?? "localhost";

  // OAuth consent password shown in the e_claude_ai_oauth card so the user can
  // copy the exact value to enter on the consent page. LOKYY_OAUTH_PASSWORD
  // wins; otherwise LOKYY_MCP_TOKEN doubles as the password (matches the
  // mcp/oauth fallback). Mirrors the httpToken placeholder style above.
  const consentPassword =
    process.env.LOKYY_OAUTH_PASSWORD ??
    process.env.LOKYY_MCP_TOKEN ??
    "<setze LOKYY_OAUTH_PASSWORD oder LOKYY_MCP_TOKEN und starte neu>";
  const consentPasswordSource = process.env.LOKYY_OAUTH_PASSWORD
    ? "LOKYY_OAUTH_PASSWORD"
    : process.env.LOKYY_MCP_TOKEN
      ? "LOKYY_MCP_TOKEN"
      : "nicht gesetzt";

  // Coolify/Dokploy-style FQDN env wins over local-dev host:port. Result is
  // built once and shared between the snippet args and the endpointUrl /
  // healthUrl fields the PWA Settings page renders verbatim.
  const fqdn = process.env.SERVICE_FQDN_LOKYY_MCP?.trim();
  const remoteEndpoint =
    fqdn && fqdn.length > 0
      ? `https://${fqdn.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/mcp`
      : `http://${publicHost}:${httpPort}/mcp`;
  const remoteHealth = `${remoteEndpoint}/health`;

  const sharedEnv = {
    LOKYY_DB_URL: maskDsn(config.databaseUrl),
    LOKYY_VAULT_DIR: config.vaultDir,
    LOKYY_GIT_REMOTE: v?.gitRemote ?? config.gitRemote,
    LOKYY_GIT_BRANCH: v?.gitBranch ?? config.gitBranch,
    LOKYY_VAULT_ID: v?.id ?? "<set-after-vault-created>",
    LOKYY_AGENT_ID: "claude-code",
  };

  return c.json({
    available: true,
    tools: ["read_note", "search_vault", "list_tree", "create_note", "update_note"],

    // Variante A: lokal stdio (läuft auf dem Host wo lokyy-brain installiert ist)
    variants: {
      a_local_stdio: {
        title: "Lokal (stdio) — dieser Rechner",
        when: "Claude Desktop läuft auf demselben Rechner wie lokyy-brain.",
        snippet: {
          mcpServers: {
            "lokyy-brain": {
              command: "node",
              args: [`${projectRoot}/mcp/dist/bin.js`],
              env: sharedEnv,
            },
          },
        },
      },

      b_npx: {
        title: "npm-Paket (npx) — beliebiger Rechner",
        when: "Anderer Rechner hat aber Zugriff auf dieselbe DB + Vault-Repo.",
        precondition: "Paket muss zu npmjs.com published sein (geplant, noch nicht done).",
        snippet: {
          mcpServers: {
            "lokyy-brain": {
              command: "npx",
              args: ["-y", "@lokyy/mcp"],
              env: sharedEnv,
            },
          },
        },
      },

      c_native_http: {
        title: "Native HTTP — empfohlen für Claude Code / Claude Desktop",
        when:
          "Du willst von Claude Code oder Claude Desktop (lokal) connecten. Der Bearer-Token wird direkt im Header mitgeschickt — das ist der richtige Weg für diese Clients. Für die claude.ai Web-App nutze stattdessen den neuen OAuth-Connector (e_claude_ai_oauth), da die claude.ai-Oberfläche kein manuelles Header-Feld anbietet.",
        precondition: [
          `Start server: pnpm --filter @lokyy/mcp start:http   (env: LOKYY_MCP_TOKEN=<token>, LOKYY_MCP_HTTP_PORT=${httpPort})`,
          `Bei public ingress: HTTPS-Reverse-Proxy davor (Caddy/nginx/traefik).`,
        ],
        instructions:
          "⚠️ Wichtig: Befehl im Terminal ausführen BEVOR du Claude Code startest. In einer bereits laufenden Claude-Session wird die mcp-Config nicht immer sauber neu geladen.",
        snippet: {
          mcpServers: {
            "lokyy-brain": {
              type: "http",
              url: remoteEndpoint,
              headers: {
                Authorization: `Bearer ${httpToken}`,
              },
            },
          },
        },
        extraSnippets: [
          {
            label: "CLI — projektbezogen (in diesem Projekt-Verzeichnis ausführen)",
            language: "bash",
            code: `claude mcp add --transport http lokyy-brain ${remoteEndpoint} --header "Authorization: Bearer ${httpToken}"`,
          },
          {
            label: "CLI — global (alle Projekte, in beliebigem Verzeichnis ausführen)",
            language: "bash",
            code: `claude mcp add --transport http --scope user lokyy-brain ${remoteEndpoint} --header "Authorization: Bearer ${httpToken}"`,
          },
        ],
        endpointUrl: remoteEndpoint,
        healthUrl: remoteHealth,
        authNote:
          "Bearer-Token: erzeuge ihn oben unter „MCP-Token“ — er gilt sofort, ohne Neustart. Der alte Weg über die Umgebungsvariable LOKYY_MCP_TOKEN funktioniert weiterhin (erfordert aber einen Neustart). Jeder Request muss `Authorization: Bearer <token>` mitschicken.",
      },

      d_mcp_remote_legacy: {
        title:
          "Legacy: mcp-remote-Bridge (falls dein Client kein natives HTTP unterstützt)",
        when:
          "Du willst von beliebigen Rechnern/Clients ohne lokyy-brain checkout connecten. Server (lokyy-mcp-http) muss laufen.",
        precondition: [
          `Start server: pnpm --filter @lokyy/mcp start:http   (env: LOKYY_MCP_TOKEN=<token>, LOKYY_MCP_HTTP_PORT=${httpPort})`,
          `Bei public ingress: HTTPS-Reverse-Proxy davor (Caddy/nginx/traefik).`,
        ],
        snippet: {
          mcpServers: {
            "lokyy-brain": {
              command: "npx",
              args: [
                "-y",
                "mcp-remote",
                remoteEndpoint,
                "--header",
                `Authorization: Bearer ${httpToken}`,
              ],
            },
          },
        },
        endpointUrl: remoteEndpoint,
        healthUrl: remoteHealth,
        authNote:
          "Bearer-Token: erzeuge ihn oben unter „MCP-Token“ — er gilt sofort, ohne Neustart. Der alte Weg über die Umgebungsvariable LOKYY_MCP_TOKEN funktioniert weiterhin (erfordert aber einen Neustart). Jeder Request muss `Authorization: Bearer <token>` mitschicken.",
      },

      e_claude_ai_oauth: {
        title: "claude.ai (Web & Desktop) — Custom Connector über OAuth",
        when:
          'Du willst lokyy-brain direkt in der claude.ai-Web-App oder Claude Desktop als „Eigenen Connector“ nutzen — ohne lokale Config-Datei. DAS ist der Weg, den die claude.ai-Oberfläche anbietet (sie hat kein Feld für einen Bearer-Token).',
        precondition: [
          "MCP-Server öffentlich per HTTPS erreichbar (lokyy-mcp-http hinter Reverse-Proxy).",
          "In Coolify gesetzt: LOKYY_OAUTH_PASSWORD (das Passwort, das du beim Verbinden eingibst) + ein starkes, zufälliges LOKYY_OAUTH_SIGNING_SECRET. Ohne LOKYY_OAUTH_PASSWORD gilt LOKYY_MCP_TOKEN als Passwort.",
        ],
        steps: [
          'In claude.ai: Einstellungen → Connectors → „Eigenen Connector hinzufügen".',
          "Name: lokyy-brain",
          `Remote MCP Server URL: ${remoteEndpoint}`,
          "OAuth Client ID und OAuth Client Secret LEER lassen — der Server registriert sich automatisch (Dynamic Client Registration).",
          'Auf „Hinzufügen"/„Verbinden" klicken. claude.ai öffnet eine Login-Seite, die der MCP-Server selbst hostet.',
          "Auf der Login-Seite dein LOKYY_OAUTH_PASSWORD eingeben (bzw. LOKYY_MCP_TOKEN, falls kein OAuth-Passwort gesetzt ist) und autorisieren.",
          "Fertig — die Tools erscheinen im Connector und du kannst lokyy-brain in claude.ai nutzen.",
        ],
        endpointUrl: remoteEndpoint,
        healthUrl: remoteHealth,
        consentPassword,
        consentPasswordSource,
        authNote:
          "OAuth 2.1 (Dynamic Client Registration RFC 7591 + PKCE S256). Der Zugriffstoken ist ein zustandsloses HS256-JWT, signiert mit LOKYY_OAUTH_SIGNING_SECRET. Kein manueller Token nötig — claude.ai bekommt ihn über den OAuth-Flow. (Der bestehende LOKYY_MCP_TOKEN funktioniert parallel weiter für Header-basierte Clients wie Claude Code.)",
      },
    },

    // Story 7.10: the literal string the UI has to replace with a freshly
    // generated token, plus whether the legacy env token is in play at all.
    tokenPlaceholder: MCP_TOKEN_MARKER,
    envToken: {
      configured: envMcpToken.length > 0,
      shared: isSharedDefaultMcpToken(envMcpToken),
    },

    scopesFile: `${config.vaultDir}/00_meta/mcp-scopes.yaml`,
    scopesFileHint:
      "Existiert → MCP lädt Agent-Berechtigungen. Fehlt → Fallback read-only **/*.md. Format akzeptiert sowohl `scopes:` (lokyy-vault SPEC) als auch `agents:` (legacy).",
  });
});

// GET /api/admin/skills — reads the real `type: skill` notes from the vault
// (Story 9-6). The vault root is resolved exactly like every other admin
// handler: from `config.vaultDir`. `listSkillNotes` returns typed SkillDefs
// (no path), so we build a `skill_name → vault-relative note id` map by
// scanning the same skills subtree and matching on `skill_name`. The id is
// the path without `.md` — the form the PWA editor opens by.
adminRoutes.get("/skills", async (c) => {
  const vaultRoot = config.vaultDir;
  const [skills, pathByName] = await Promise.all([
    listSkillNotes(vaultRoot),
    buildSkillPathMap(vaultRoot),
  ]);

  return c.json({
    skills: skills.map((s) => ({
      skill_name: s.skill_name,
      title: s.title,
      description: s.description,
      allowed_tools: s.allowed_tools,
      // `path` is the vault-relative id (no `.md`); null when the note can't
      // be located (defensive — should not happen for a parsed skill).
      path: pathByName.get(s.skill_name) ?? null,
    })),
  });
});

// Recursively collect a `skill_name → vault-relative-id` map. Mirrors the
// directory-resolution order of `listSkillNotes` (prefer `70_pai/skills/`,
// fall back to the whole vault) so paths line up with the parsed skills.
async function buildSkillPathMap(
  vaultRoot: string,
): Promise<Map<string, string>> {
  const skillsDir = join(vaultRoot, "70_pai", "skills");
  let files = await walkMarkdownFiles(skillsDir);
  if (files.length === 0) files = await walkMarkdownFiles(vaultRoot);

  const map = new Map<string, string>();
  for (const abs of files) {
    let raw: string;
    try {
      raw = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const { data } = parseFrontmatter(raw);
    if (data.type !== "skill") continue;
    const name = data.skill_name as string | undefined;
    if (!name) continue;
    const relId = relative(vaultRoot, abs)
      .split(sep)
      .join("/")
      .replace(/\.md$/, "");
    map.set(name, relId);
  }
  return map;
}

async function walkMarkdownFiles(
  dir: string,
  acc: string[] = [],
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkMarkdownFiles(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function maskDsn(dsn: string): string {
  return dsn.replace(/(:)([^@]+)(@)/, "$1***$3");
}

async function checkPostgres(dsn: string) {
  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(dsn, { max: 1, idle_timeout: 2 });
    await sql`SELECT 1`;
    const ext =
      await sql<{ extversion: string }[]>`SELECT extversion FROM pg_extension WHERE extname='vector'`;
    return { ok: true, pgvector: ext[0]?.extversion ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  } finally {
    if (sql) await sql.end();
  }
}

async function checkOllama(url: string) {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as { models?: { name: string }[] };
    const hasNomic = data.models?.some((m) => m.name.startsWith("nomic-embed-text"));
    return { ok: true, hasNomicEmbed: !!hasNomic };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}
