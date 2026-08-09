import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Accepting a topic note must be all-or-nothing.
 *
 * The bug this file pins down was found in production: topic-synthesis
 * re-generated a cluster whose summary the user had already accepted, so
 * `auto-{slug}.md` and `20_notes/topics/{slug}.md` existed at the same time.
 * Accept then did its two steps in the worst possible order — it committed the
 * `origin: curated` frontmatter rewrite first and only THEN ran the move, which
 * `git mv` refused because the destination was taken:
 *
 *     fatal: destination exists, source=70_pai/topics/auto-x.md, …
 *
 * The note was left in the auto folder carrying `origin: curated`, and both
 * accept and reject refuse anything that is not `origin: agent` — so the user
 * got "topic note … is not in agent state (origin=curated)" on every retry,
 * with no way back through the UI. The queue had dropped it too (it filters on
 * `origin === "agent"`), so the file just sat there invisible.
 *
 * The three cases below are the contract: a clean accept moves, a colliding
 * accept refuses BEFORE writing anything, and a move that fails for any other
 * reason puts the frontmatter back.
 */

process.env.DATABASE_URL ??= "postgres://unused:unused@localhost:1/unused";

/** id (without .md) → raw file content. Stands in for the git-backed vault. */
let vault: Map<string, string>;
/** Every mutation the route performed, in order — the assertions read this. */
let writes: string[];
/** When set, `moveEntry` throws it — the "git said no" seam. */
let moveError: Error | null;

const AUTO_ID = "70_pai/topics/auto-projekt-001";
const TARGET_ID = "20_notes/topics/projekt-001";

function agentNote(title: string): string {
  return [
    "---",
    "id: 01KZJ7TG7PTWAKDD7RH3EZ9S13",
    "type: intervention",
    `title: ${title}`,
    "intervention_kind: topic_note",
    "status: pending",
    "origin: agent",
    "confidence: 0.6",
    "---",
    "",
    `# ${title}`,
    "",
    "Zusammenfassung.",
  ].join("\n");
}

vi.mock("@lokyy/core", async (importOriginal) => {
  // Keep the real frontmatter parser/serializer — the route's whole job is
  // rewriting frontmatter, and a fake one would test nothing.
  const actual = await importOriginal<typeof import("@lokyy/core")>();
  return {
    ...actual,
    listNotes: async () =>
      [...vault.keys()].map((id) => ({ id, title: id, tags: [], links: [] })),
    getNote: async (id: string) => {
      const body = vault.get(id);
      return body ? { id, title: id, body, tags: [], links: [], aliases: [] } : null;
    },
    saveNote: async (id: string, body: string) => {
      writes.push(`save:${id}`);
      vault.set(id, body);
      return { id, title: id, body, tags: [], links: [], aliases: [] };
    },
    moveEntry: async (from: string, to: string) => {
      writes.push(`move:${from}->${to}`);
      if (moveError) throw moveError;
      const body = vault.get(from);
      if (body === undefined) throw new Error(`missing source ${from}`);
      vault.delete(from);
      vault.set(to, body);
    },
    deleteEntry: async (id: string) => {
      writes.push(`delete:${id}`);
      vault.delete(id);
    },
  };
});

async function makeApp(): Promise<Hono> {
  const { agentReviewRoutes } = await import("./agent-review.js");
  const app = new Hono();
  app.route("/api/agent-review", agentReviewRoutes);
  return app;
}

function acceptUrl(id: string): string {
  return `/api/agent-review/topic-note/${id}/accept`;
}

beforeEach(() => {
  vault = new Map([[AUTO_ID, agentNote("Projekt 001")]]);
  writes = [];
  moveError = null;
});

describe("POST /topic-note/:id/accept", () => {
  it("moves the note and marks it curated when the target is free", async () => {
    const app = await makeApp();

    const res = await app.request(acceptUrl(AUTO_ID), { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from: AUTO_ID, to: TARGET_ID });
    expect(vault.has(AUTO_ID)).toBe(false);
    expect(vault.get(TARGET_ID)).toContain("origin: curated");
  });

  it("refuses with 409 when the topic was already accepted — and writes nothing", async () => {
    vault.set(TARGET_ID, agentNote("Projekt 001").replace("origin: agent", "origin: curated"));
    const app = await makeApp();

    const res = await app.request(acceptUrl(AUTO_ID), { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ target: TARGET_ID });
    // The decisive part: no write happened, so the note is still `origin: agent`
    // and the user can still reject it from the queue.
    expect(writes).toEqual([]);
    expect(vault.get(AUTO_ID)).toContain("origin: agent");
  });

  it("rolls the frontmatter back when the move fails for another reason", async () => {
    moveError = new Error("fatal: unable to write new index file");
    const app = await makeApp();

    const res = await app.request(acceptUrl(AUTO_ID), { method: "POST" });

    expect(res.status).toBe(500);
    expect(vault.get(AUTO_ID)).toContain("origin: agent");
    expect(vault.get(AUTO_ID)).not.toContain("accepted_at");
    // save → move (throws) → save-back. Without the rollback the note would be
    // stranded as curated-but-not-moved.
    expect(writes).toEqual([
      `save:${AUTO_ID}`,
      `move:${AUTO_ID}->${TARGET_ID}`,
      `save:${AUTO_ID}`,
    ]);
  });

  it("still refuses a note that is not in agent state", async () => {
    vault.set(AUTO_ID, agentNote("Projekt 001").replace("origin: agent", "origin: curated"));
    const app = await makeApp();

    const res = await app.request(acceptUrl(AUTO_ID), { method: "POST" });

    expect(res.status).toBe(422);
    expect(writes).toEqual([]);
  });
});
