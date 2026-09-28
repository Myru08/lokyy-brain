import { describe, expect, it, vi } from "vitest";
import type { IngestProposal } from "@lokyy/shared";

import { applyIngestProposals, type ApplyDeps } from "./apply.js";

/**
 * Issue #67 — Freigeben und Ablehnen.
 *
 * Der Kern der Entscheidung „nichts ohne Freigabe": geprüft wird, dass ein
 * abgelehnter Vorschlag den Vault NICHT berührt und trotzdem im Log bleibt,
 * dass ein Widerspruch im bestehenden `lintFindings`-Format landet (und nicht
 * in einem zweiten Review-System), und dass eine unbekannte ID benannt in
 * `skipped` erscheint statt zu werfen.
 */

function proposal(over: Partial<IngestProposal> = {}): IngestProposal {
  return {
    id: "p1",
    vaultId: "vault-test",
    jobId: "job-1",
    action: "link",
    sourceNoteId: "30_captures/urls/neu",
    targetNoteId: "50_decisions/postgres",
    rationale: "Rückverweis fehlt",
    status: "pending",
    evidence: { prefilter: { noteId: "50_decisions/postgres" } },
    createdAt: "2026-09-26T10:00:00.000Z",
    decidedAt: null,
    ...over,
  };
}

interface Harness {
  deps: Partial<ApplyDeps>;
  saveNote: ReturnType<typeof vi.fn>;
  writeLintFinding: ReturnType<typeof vi.fn>;
  statusCalls: Array<{ id: string; status: string; patch?: unknown }>;
}

function harness(
  rows: IngestProposal[],
  opts: { body?: string; noteMissing?: boolean; saveThrows?: Error } = {},
): Harness {
  const statusCalls: Harness["statusCalls"] = [];
  const saveNote = vi.fn(async () => {
    if (opts.saveThrows) throw opts.saveThrows;
    return undefined;
  });
  const writeLintFinding = vi.fn(async () => undefined);

  return {
    saveNote,
    writeLintFinding,
    statusCalls,
    deps: {
      loadProposals: async (ids) => rows.filter((r) => ids.includes(r.id)),
      setStatus: async (id, status, patch) => {
        statusCalls.push({ id, status, patch });
        const row = rows.find((r) => r.id === id);
        return row ? { ...row, status, decidedAt: "2026-09-26T11:00:00.000Z" } : null;
      },
      getNote: async () =>
        opts.noteMissing ? null : { body: opts.body ?? "# Postgres\n\nText.\n" },
      saveNote,
      writeLintFinding,
      log: () => {},
    },
  };
}

describe("applyIngestProposals", () => {
  it("wendet einen freigegebenen link-Vorschlag an", async () => {
    const h = harness([proposal()]);

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.applied.map((p) => p.id)).toEqual(["p1"]);
    expect(res.skipped).toEqual([]);
    expect(h.saveNote).toHaveBeenCalledTimes(1);
    const [, body] = h.saveNote.mock.calls[0] as [string, string];
    expect(body).toContain("[[30_captures/urls/neu]]");
    expect(h.statusCalls[0]).toMatchObject({ id: "p1", status: "applied" });
  });

  it("schreibt bei einem abgelehnten Vorschlag NICHTS und behält ihn im Log", async () => {
    const h = harness([proposal()]);

    const res = await applyIngestProposals(
      { approved: [], rejected: ["p1"] },
      h.deps,
    );

    expect(h.saveNote).not.toHaveBeenCalled();
    expect(h.writeLintFinding).not.toHaveBeenCalled();
    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual([
      { id: "p1", reason: "abgelehnt — nichts geschrieben" },
    ]);
    expect(h.statusCalls[0]).toMatchObject({ id: "p1", status: "rejected" });
  });

  it("meldet eine unbekannte ID benannt in skipped, ohne zu werfen", async () => {
    const h = harness([]);

    const res = await applyIngestProposals(
      { approved: ["gibtsnicht"], rejected: [] },
      h.deps,
    );

    expect(res.applied).toEqual([]);
    expect(res.skipped).toEqual([
      { id: "gibtsnicht", reason: "unbekannte Proposal-ID" },
    ]);
  });

  it("überspringt einen schon entschiedenen Vorschlag mit Grund", async () => {
    const h = harness([proposal({ status: "applied" })]);

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.skipped[0]?.reason).toMatch(/schon entschieden \(status=applied\)/);
    expect(h.saveNote).not.toHaveBeenCalled();
  });

  it("schreibt einen Widerspruch ins bestehende lintFindings-Format", async () => {
    const h = harness([
      proposal({ action: "flag_contradiction", rationale: "Widerspruch zu X" }),
    ]);

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.applied).toHaveLength(1);
    // Kein Vault-Write: der Fund MELDET nur.
    expect(h.saveNote).not.toHaveBeenCalled();
    expect(h.writeLintFinding).toHaveBeenCalledWith({
      noteIds: ["30_captures/urls/neu", "50_decisions/postgres"],
      message: "Widerspruch zu X",
      evidence: expect.objectContaining({
        source: "ingest-synthesis",
        proposalId: "p1",
        jobId: "job-1",
      }),
    });
  });

  it("überspringt eine nicht anwendbare Aktion benannt", async () => {
    const h = harness([proposal({ action: "merge" })]);

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.applied).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/"merge" wird von dieser Version nicht/);
  });

  it("überspringt einen link-Vorschlag, dessen Zielnotiz verschwunden ist", async () => {
    const h = harness([proposal()], { noteMissing: true });

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.skipped[0]?.reason).toMatch(/existiert nicht mehr/);
    expect(h.statusCalls).toEqual([]);
  });

  it("markiert einen fehlgeschlagenen Write als failed und nennt den Grund", async () => {
    const h = harness([proposal()], { saveThrows: new Error("pre-commit-hook") });

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.applied).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/Anwenden fehlgeschlagen: pre-commit-hook/);
    expect(h.statusCalls[0]).toMatchObject({
      id: "p1",
      status: "failed",
      patch: { applyError: "pre-commit-hook" },
    });
  });

  it("schreibt einen schon vorhandenen Rückverweis nicht doppelt", async () => {
    const h = harness([proposal()], {
      body: "# Postgres\n\n## Siehe auch\n\n- [[30_captures/urls/neu]]\n",
    });

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: [] },
      h.deps,
    );

    expect(res.applied).toHaveLength(1);
    expect(h.saveNote).not.toHaveBeenCalled();
  });

  it("entscheidet nichts, wenn eine ID freigegeben UND abgelehnt wurde", async () => {
    const h = harness([proposal()]);

    const res = await applyIngestProposals(
      { approved: ["p1"], rejected: ["p1"] },
      h.deps,
    );

    expect(res.applied).toEqual([]);
    expect(res.skipped[0]?.reason).toMatch(/gleichzeitig freigegeben und abgelehnt/);
    expect(h.statusCalls).toEqual([]);
    expect(h.saveNote).not.toHaveBeenCalled();
  });
});
