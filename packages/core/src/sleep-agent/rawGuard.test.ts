import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";

import { initCore } from "../util/coreConfig.js";
import {
  RAW_ROOT,
  isUnderRaw,
  isRawImmutable,
  isHandsOffZone,
} from "./rawGuard.js";

// The passes call serialize/ULID helpers that read `coreConfig()`; inject a
// dummy slice once so the in-memory run never throws "core not initialized".
// notesService itself is fully mocked below, so vaultDir is never touched.
beforeAll(() => {
  initCore({
    vaultDir: "/tmp/lokyy-rawguard-test",
    gitRemote: "",
    gitBranch: "main",
    gitAuthorName: "t",
    gitAuthorEmail: "t@localhost",
  });
});

/* ================================================================== *
 *  Story S4 — RAW-Immutabilität (verbatim-Garantie).
 *
 *  Part 1 — the pure guard decision logic.
 *  Part 2 — the two SYSTEM-driven note-rewrite passes (ulid-backfill,
 *           peer-profile-update) leave karpathy RAW notes bit-identical,
 *           still process karpathy Wiki notes, skip `RAW/_x/`, and behave
 *           byte-identically under `para`.
 * ================================================================== */

describe("rawGuard — pure decision logic (Story S4)", () => {
  it("RAW_ROOT is the karpathy raw-source folder", () => {
    expect(RAW_ROOT).toBe("RAW");
  });

  it("isUnderRaw is segment-aware (RAW + RAW/… yes, RAW_archiv no)", () => {
    expect(isUnderRaw("RAW")).toBe(true);
    expect(isUnderRaw("RAW/2026-06-17_transkript")).toBe(true);
    expect(isUnderRaw("RAW/transkripte/x")).toBe(true);
    expect(isUnderRaw("/RAW/x")).toBe(true); // leading slash tolerated
    expect(isUnderRaw("RAW_archiv/x")).toBe(false); // not a RAW sub-tree
    expect(isUnderRaw("Wiki/thema")).toBe(false);
    expect(isUnderRaw("20_notes/x")).toBe(false);
  });

  it("isRawImmutable: karpathy RAW → true, everything else → false", () => {
    // karpathy: RAW is immutable, Wiki/Outputs are not.
    expect(isRawImmutable("RAW/2026-06-17_quelle", "karpathy")).toBe(true);
    expect(isRawImmutable("RAW", "karpathy")).toBe(true);
    expect(isRawImmutable("Wiki/thema", "karpathy")).toBe(false);
    expect(isRawImmutable("Outputs/report", "karpathy")).toBe(false);
  });

  it("isRawImmutable under para is ALWAYS false (AC#3 bit-identical)", () => {
    // para has no RAW concept — even a path that happens to be `RAW/…`
    // must not be treated as immutable; the guard is a no-op under para.
    expect(isRawImmutable("RAW/x", "para")).toBe(false);
    expect(isRawImmutable("RAW", "para")).toBe(false);
    expect(isRawImmutable("20_notes/x", "para")).toBe(false);
  });

  it("isHandsOffZone: RAW/_<name>/ first segment underscore (profile-free)", () => {
    expect(isHandsOffZone("RAW/_inbox/note")).toBe(true);
    expect(isHandsOffZone("RAW/_x")).toBe(true); // zone root itself
    expect(isHandsOffZone("RAW/_archiv/tief/note")).toBe(true);
    // regular RAW notes are NOT hands-off (they may be read/distilled)
    expect(isHandsOffZone("RAW/2026-06-17_quelle")).toBe(false);
    expect(isHandsOffZone("RAW/transkripte/x")).toBe(false);
    expect(isHandsOffZone("RAW")).toBe(false);
    // outside RAW entirely
    expect(isHandsOffZone("20_notes/_draft")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 *  Part 2 — pass-level guards. We mock notesService so the passes run
 *  without a vault/git, capturing every saveNote call. A RAW note that
 *  is never passed to saveNote is, by construction, bit-identical.
 * ------------------------------------------------------------------ */

interface FakeNote {
  id: string;
  body: string; // full markdown incl. frontmatter
  tags?: string[];
}

const saveCalls: { id: string; body: string }[] = [];
let fakeVault: FakeNote[] = [];

vi.mock("../notes/notesService.js", () => ({
  listNotes: async () =>
    fakeVault.map((n) => ({
      id: n.id,
      title: n.id.split("/").pop() ?? n.id,
      tags: n.tags ?? [],
      updatedAt: new Date().toISOString(),
    })),
  getNote: async (id: string) => {
    const n = fakeVault.find((x) => x.id === id);
    return n ? { id, title: id, body: n.body, tags: n.tags ?? [], links: [] } : null;
  },
  saveNote: async (id: string, body: string) => {
    saveCalls.push({ id, body });
    return { id, title: id, body, tags: [], links: [] };
  },
}));

// A RAW note WITHOUT a ULID — exactly the kind ulid-backfill would rewrite
// if the guard didn't stop it. Verbatim body must survive untouched.
const RAW_NOTE_BODY =
  "---\ntitle: Originalquelle\n---\nDies ist wörtlicher RAW-Inhalt. NICHT anfassen.\n";
const HANDSOFF_BODY =
  "---\ntitle: Inbox-Roh\n---\nHände weg.\n";
// A karpathy Wiki note without a ULID — SHOULD still be processed/backfilled.
const WIKI_NOTE_BODY =
  "---\ntitle: Thema\ntype: wiki-article\n---\nDestillat.\n";

describe("ulid-backfill respects RAW immutability (Story S4)", () => {
  beforeEach(() => {
    saveCalls.length = 0;
    delete process.env.LOKYY_VAULT_PROFILE;
  });
  afterEach(() => {
    delete process.env.LOKYY_VAULT_PROFILE;
  });

  it("karpathy: leaves a RAW note untouched, still backfills a Wiki note, skips RAW/_x/", async () => {
    process.env.LOKYY_VAULT_PROFILE = "karpathy";
    fakeVault = [
      { id: "RAW/2026-06-17_quelle", body: RAW_NOTE_BODY },
      { id: "RAW/_inbox/roh", body: HANDSOFF_BODY },
      { id: "Wiki/thema", body: WIKI_NOTE_BODY },
    ];

    const { ulidBackfillPass } = await import("./passes/ulidBackfill.js");
    const res = await ulidBackfillPass.run({} as never);

    const savedIds = saveCalls.map((c) => c.id);
    // RAW note + hands-off zone: NEVER written.
    expect(savedIds).not.toContain("RAW/2026-06-17_quelle");
    expect(savedIds).not.toContain("RAW/_inbox/roh");
    // Wiki note: backfilled (rewritten with a ULID).
    expect(savedIds).toContain("Wiki/thema");
    expect(res.processed).toBe(1);
  });

  it("para: a note at a RAW/ path IS backfilled (AC#3 — guard is a no-op)", async () => {
    process.env.LOKYY_VAULT_PROFILE = "para";
    fakeVault = [{ id: "RAW/legacy", body: RAW_NOTE_BODY }];

    const { ulidBackfillPass } = await import("./passes/ulidBackfill.js");
    const res = await ulidBackfillPass.run({} as never);

    // Under para there is no RAW concept — legacy behaviour is unchanged,
    // so this untyped legacy note gets a ULID like any other.
    expect(saveCalls.map((c) => c.id)).toContain("RAW/legacy");
    expect(res.processed).toBe(1);
  });
});
