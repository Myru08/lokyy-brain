import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";

import { initDb, closeDb, database, runMigrations } from "../db/index.js";
import { initCore } from "../util/coreConfig.js";
import { ensureRepo } from "../git/gitService.js";
import { createNote } from "../notes/notesService.js";
import { getMemoryProvider, getTier1BM25 } from "./index.js";

/**
 * Story 5.8 AC#7 — THE Definition of Done.
 *
 * Saves a note through the NORMAL write path (`createNote`) and then finds it
 * again through `CombinedProvider.search()` using a query that shares NO
 * keyword with the note — with no manual, out-of-band embedding step in
 * between. This mirrors the community reporter's own successful direct-Tier-2
 * probe ("account blowup protection position sizing" → the risk-management
 * note), which proved the embeddings WORK while the pipeline around them did
 * not.
 *
 * It exercises all four sub-fixes at once, which is the point — each of them
 * alone leaves semantic search dead in production:
 *   AC#1/#2 the save path calls the Tier-2 hook with a REAL `vaults(id)`,
 *           so the insert survives `note_embeddings`' foreign key;
 *   AC#3/#4 every chunk fits `nomic-embed-text`'s 2048-token window, so
 *           Ollama does not reject it;
 *   AC#6    the merge reserves capacity for Tier 2, so the hit is not starved
 *           by the 25 keyword hits that DO match the query.
 *
 * GATED (like `searchHardening.db.test.ts`) so CI without Postgres/Ollama
 * stays green. Run against a THROWAWAY database:
 *
 *   LOKYY_TEST_DATABASE_URL=postgres://postgres:pw@host:5432/lokyy_s58_e2e \
 *   LOKYY_TEST_OLLAMA_HOST=http://host:11434 \
 *     pnpm --filter @lokyy/core test semanticSearchE2E
 */

const DB_URL = process.env.LOKYY_TEST_DATABASE_URL;
const OLLAMA = process.env.LOKYY_TEST_OLLAMA_HOST;
const exec = promisify(execFile);

const VAULT_ID = "01S58E2EVAULT00000000000000";
/** Enough keyword-matching notes to fill `LIMIT` on the Tier-1 leg alone. */
const DECOY_COUNT = 25;
const LIMIT = 25;
const OWNER_ID = "01S58E2EUSER000000000000000";

/**
 * Query and note deliberately share ZERO words. "account", "blowup",
 * "protection", "position" and "sizing" appear nowhere in the note; the note
 * talks about portfolio, equity, wager, stop loss and drawdown instead.
 */
const QUERY = "account blowup protection position sizing";
const NOTE_TITLE = "Never Wager The Whole Purse";
const NOTE_BODY = [
  "# Never Wager The Whole Purse",
  "",
  "Risk at most one percent of the portfolio on any single trade.",
  "",
  "Always place a hard stop loss before entering, and scale every buy",
  "relative to total equity so that a long losing streak produces a",
  "survivable drawdown instead of wiping out the fund.",
].join("\n");

let base: string;
let noteId: string;

async function setupVault(): Promise<string> {
  base = await mkdtemp(join(tmpdir(), "lokyy-s58-e2e-"));
  const remote = join(base, "remote");
  const workdir = join(base, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  const seed = join(base, "seed");
  await exec("git", ["init", "--initial-branch=main", seed]);
  await exec("git", ["-C", seed, "commit", "--allow-empty", "-m", "init"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lokyy-test",
      GIT_AUTHOR_EMAIL: "test@localhost",
      GIT_COMMITTER_NAME: "lokyy-test",
      GIT_COMMITTER_EMAIL: "test@localhost",
    },
  });
  await exec("git", ["-C", seed, "remote", "add", "origin", remote]);
  await exec("git", ["-C", seed, "push", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  initCore({
    vaultDir: workdir,
    gitRemote: remote,
    gitBranch: "main",
    gitAuthorName: "lokyy-test",
    gitAuthorEmail: "test@localhost",
    // AC#2: the REAL vaults-table id, injected exactly like the server/MCP
    // entry points now do.
    vaultId: VAULT_ID,
  });
  await ensureRepo();
  return workdir;
}

/** Wait for the fire-and-forget Tier-2 hook to land its rows. */
async function waitForEmbeddings(id: string, timeoutMs = 120_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await database().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM note_embeddings
      WHERE note_id = ${id} AND vault_id = ${VAULT_ID}
    `);
    const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
    if (n > 0) return n;
    if (Date.now() > deadline) return 0;
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe.skipIf(!DB_URL || !OLLAMA)(
  "Story 5.8 AC#7 — save a note, find it semantically, no manual indexing",
  () => {
    beforeAll(async () => {
      // Tier2Provider reads OLLAMA_HOST when no explicit host is configured.
      process.env.OLLAMA_HOST = OLLAMA;
      await runMigrations(DB_URL!);
      initDb(DB_URL!);

      // note_embeddings.vault_id REFERENCES vaults(id), vaults.owner_id
      // REFERENCES users(id) — the FK chain that silently rejected every
      // Tier-2 insert while the placeholder vault id was in use.
      await database().execute(sql`
        INSERT INTO users (id, email, password_hash, name)
        VALUES (${OWNER_ID}, 's58-e2e@localhost', 'x', 'S58 E2E')
        ON CONFLICT (id) DO NOTHING
      `);
      await database().execute(sql`
        INSERT INTO vaults (id, name, slug, kind, owner_id, git_remote)
        VALUES (${VAULT_ID}, 'S58 E2E', 's58-e2e', 'personal', ${OWNER_ID}, '')
        ON CONFLICT (id) DO NOTHING
      `);
      await database().execute(sql`
        DELETE FROM note_embeddings WHERE vault_id = ${VAULT_ID}
      `);
      await database().execute(sql`DELETE FROM note_search WHERE vault_id = ${VAULT_ID}`);

      await setupVault();

      // 25 decoy notes that DO match every keyword of the query, written
      // through the same real path. They exist to fill `limit` on the Tier-1
      // leg — the exact condition under which the old merge could never return
      // a semantic hit (AC#6).
      for (let i = 0; i < DECOY_COUNT; i++) {
        await createNote(
          `20_notes/decoy-${i}`,
          `# Account Position Sizing ${i}\n\naccount blowup protection position sizing checklist ${i}`,
          { type: "note", title: `Account Position Sizing ${i}` },
        );
      }

      // THE write under test — the normal path, nothing else.
      const created = await createNote("20_notes/never-wager-the-whole-purse", NOTE_BODY, {
        type: "note",
        title: NOTE_TITLE,
      });
      noteId = created.id;
      await waitForEmbeddings(noteId);

      // Drop the DECOYS' embeddings (never the target's). The decoys quote the
      // query verbatim, so leaving them in the dense index would make them win
      // the semantic leg too and the test would measure ranking, not the
      // structural starvation AC#6 is about. Removing them reproduces the
      // reporter's actual situation: a vault whose keyword index is populated
      // while the dense index holds only the note that matters.
      await database().execute(sql`
        DELETE FROM note_embeddings
        WHERE vault_id = ${VAULT_ID} AND note_id <> ${noteId}
      `);
    }, 300_000);

    afterAll(async () => {
      if (DB_URL && OLLAMA) {
        await database().execute(sql`DELETE FROM note_embeddings WHERE vault_id = ${VAULT_ID}`);
        await database().execute(sql`DELETE FROM note_search WHERE vault_id = ${VAULT_ID}`);
        await database().execute(sql`DELETE FROM vaults WHERE id = ${VAULT_ID}`);
        await database().execute(sql`DELETE FROM users WHERE id = ${OWNER_ID}`);
        await closeDb();
      }
      if (base) await rm(base, { recursive: true, force: true });
    });

    it("AC#1/#2/#3/#4 — saving the note produced embeddings under the real vault id", async () => {
      const count = await waitForEmbeddings(noteId);
      // title + body_full + section = 3 chunks minimum for this note.
      expect(count).toBeGreaterThanOrEqual(3);
    }, 180_000);

    it("AC#7 — the note is found by a query that shares no keyword with it", async () => {
      await waitForEmbeddings(noteId);

      const provider = getMemoryProvider(VAULT_ID);

      // Sanity 1: the keyword leg fills the whole limit on its own — the
      // precise condition under which the pre-fix merge returned zero
      // semantic hits. (`CombinedProvider` uses this same structural leg here:
      // its BM25 leg yields nothing in this environment, so it falls back to
      // `t1.search` exactly as measured below.)
      const t1Hits = await provider.t1.search(QUERY, { limit: LIMIT });
      expect(t1Hits).toHaveLength(LIMIT);

      // Sanity 2: the keyword leg genuinely cannot find the target note, so a
      // hit can only have come from the semantic leg.
      expect(t1Hits.some((h) => h.noteId === noteId)).toBe(false);
      expect(await getTier1BM25().search(QUERY, LIMIT, VAULT_ID)).not.toContainEqual(
        expect.objectContaining({ noteId }),
      );

      const hits = await provider.search(QUERY, { limit: LIMIT });
      const hit = hits.find((h) => h.noteId === noteId);
      expect(hit, `note not in ${hits.length} hits: ${hits.map((h) => h.noteId).join(", ")}`)
        .toBeDefined();
      expect(hit!.tier).toBe("t2");
    }, 180_000);
  },
);
