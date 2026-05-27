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
} from "@lokyy/core";
import { config } from "../config.js";


const exec = promisify(execFile);

export const adminRoutes = new Hono();

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
  try {
    await exec("git", ["ls-remote", "--heads", gitRemote, gitBranch], {
      timeout: 10_000,
    });
  } catch (err) {
    return c.json(
      {
        error: "remote-unreachable",
        message: err instanceof Error ? err.message : String(err),
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
  const workdir = config.vaultDir;
  const stages: { step: string; ok: boolean; message?: string }[] = [];
  try {
    await exec("git", ["-C", workdir, "remote", "set-url", "origin", gitRemote]);
    stages.push({ step: "remote-set-url", ok: true });
  } catch (err) {
    stages.push({
      step: "remote-set-url",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
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
  try {
    await exec("git", ["-C", workdir, "fetch", "origin", gitBranch], {
      timeout: 30_000,
    });
    stages.push({ step: "fetch", ok: true });
  } catch (err) {
    stages.push({
      step: "fetch",
      ok: false,
      message: err instanceof Error ? err.message.slice(0, 300) : String(err),
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
        rebaseStatus = `fail: ${mergeErr instanceof Error ? mergeErr.message.slice(0, 200) : "unknown"}`;
      }
    } else {
      rebaseStatus = `fail: ${msg.slice(0, 200)}`;
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
        message: err instanceof Error ? err.message.slice(0, 300) : String(err),
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

// GET /api/admin/status — live health of dependencies
adminRoutes.get("/status", async (c) => {
  const [forgejo, postgresStatus, ollama] = await Promise.all([
    checkForgejo(config.gitRemote, config.gitBranch),
    checkPostgres(config.databaseUrl),
    checkOllama(process.env.OLLAMA_HOST ?? "http://localhost:11434"),
  ]);
  return c.json({ forgejo, postgres: postgresStatus, ollama });
});

// GET /api/admin/mcp-info — connection info for Claude Desktop / other MCP clients (Story 1.12 + Epic 7)
//
// Liefert 3 Snippet-Varianten:
//   A) local stdio (default, läuft NUR auf diesem Rechner)
//   B) npm via npx (für andere Rechner ohne lokyy-brain checkout)
//   C) Remote HTTP (überall einbindbar, braucht laufenden lokyy-mcp-http server + Token)
adminRoutes.get("/mcp-info", async (c) => {
  const projectRoot = process.env.LOKYY_PROJECT_ROOT ?? process.cwd().replace(/\/server$/, "");
  const vaultRows = await database().select().from(vaults).limit(1);
  const v = vaultRows[0];
  const httpPort = Number(process.env.LOKYY_MCP_HTTP_PORT ?? 8788);
  const httpToken = process.env.LOKYY_MCP_TOKEN ?? "<set-LOKYY_MCP_TOKEN-env-and-restart>";
  const publicHost = process.env.LOKYY_PUBLIC_HOST ?? "localhost";

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

      c_remote_http: {
        title: "Remote HTTP — überall einbindbar (auch via Internet)",
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
                `Authorization:Bearer ${httpToken}`,
              ],
            },
          },
        },
        endpointUrl: remoteEndpoint,
        healthUrl: remoteHealth,
        authNote:
          "Bearer-Token aus env LOKYY_MCP_TOKEN. Jeder Request muss `Authorization: Bearer <token>` mitschicken. Ohne Token startet der HTTP-Server gar nicht.",
      },
    },

    scopesFile: `${config.vaultDir}/00_meta/mcp-scopes.yaml`,
    scopesFileHint:
      "Existiert → MCP lädt Agent-Berechtigungen. Fehlt → Fallback read-only **/*.md. Format akzeptiert sowohl `scopes:` (lokyy-vault SPEC) als auch `agents:` (legacy).",
  });
});

// GET /api/admin/skills — known PAI skills + concrete howToUse examples
adminRoutes.get("/skills", async (c) => {
  return c.json({
    skills: [
      {
        name: "Knowledge",
        description:
          "PAI Knowledge skill — speichert wiederverwendbare Knowledge-Entries als Vault-Notes.",
        installHint: "Built-in zu PAI 5.0+. /knowledge in Claude Code.",
        howToUse:
          'In Claude Desktop / Claude Code: "Speichere als Knowledge-Entry: [Text]". Der Skill ruft via lokyy-brain MCP `create_note` mit `type: note` in `20_notes/knowledge/` auf.',
        examplePrompt:
          'Speichere als Knowledge: "Cosine similarity > 0.85 ist ein guter Cluster-Threshold für nomic-embed-text in 768-dim."',
        worksWith: ["read_note", "search_vault", "create_note"],
      },
      {
        name: "Telos",
        description:
          "Life-OS Goals/Strategies/Beliefs Tracking. Mirror's Daten als type: project / decision Notes in den Vault.",
        installHint: "Built-in zu PAI. /interview startet TELOS-Setup; /telos update zum Bearbeiten.",
        howToUse:
          "Lokal in `~/.claude/PAI/USER/TELOS/*.md`. Mit lokyy-brain MCP zusätzlich `update_note` auf `10_projects/<goal>` oder `50_decisions/<key>` — dein Vault kennt dann deine Lebensziele.",
        examplePrompt: "Update mein Ziel G1: Fortschritt — Skool auf 1000 Members.",
        worksWith: ["read_note", "create_note", "update_note"],
      },
      {
        name: "ZK Steward",
        description:
          "Zettelkasten-Maintenance — verlinkt verwandte Notes über Wikilinks, schlägt Topic-Notes vor.",
        installHint: "Agent(subagent_type='ZK Steward') in Claude Code.",
        howToUse:
          'Agent("ZK Steward") starten: "Scan 20_notes auf orphans, schlag Verbindungen vor". Nutzt list_tree + read_note + update_note.',
        examplePrompt:
          'Agent("ZK Steward"): "Scan 20_notes und 30_captures auf orphan-notes und schlag Topic-Notes für recurring themes vor."',
        worksWith: ["list_tree", "read_note", "update_note"],
      },
      {
        name: "Research",
        description:
          "Multi-source web-research (Perplexity + Gemini + Claude). Output landet als capture-note im Vault.",
        installHint: "Built-in zu PAI. /research für Quick, /research extensive für Deep.",
        howToUse:
          'In Claude Code: Skill("Research", "deep dive on pgvector HNSW tuning") — am Ende: "Speichere als Capture-Note in 30_captures/research/".',
        examplePrompt: "Recherchiere drizzle-orm vs prisma für embedding-workloads. Output als Capture-Note.",
        worksWith: ["create_note"],
      },
    ],
  });
});

function maskDsn(dsn: string): string {
  return dsn.replace(/(:)([^@]+)(@)/, "$1***$3");
}

async function checkForgejo(remote: string, branch: string) {
  try {
    await exec("git", ["ls-remote", "--heads", remote, branch], { timeout: 5_000 });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
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
