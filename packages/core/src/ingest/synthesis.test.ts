import { describe, expect, it, vi } from "vitest";
import type { IngestProposal } from "@lokyy/shared";

import { runIngestSynthesis, type IngestSynthesisDeps } from "./synthesis.js";
import type { NewIngestProposal } from "./proposalStore.js";
import type { CandidateNote } from "./prefilter.js";
import type { ChatResult } from "../llm/types.js";

/**
 * Issue #67 — die Synthese-Stufe im Import-Pfad.
 *
 * Geprüft wird, was diese Stufe gefährlich macht, nicht was sie im Glücksfall
 * tut: kein LLM-Aufruf ohne Vorfilter-Treffer, ein Zeitbudget, das wirklich
 * abbricht, ein Fehler, der nur Vorschläge kostet — und dass nichts still
 * verschluckt wird. Ohne Vault, ohne DB, ohne Ollama: alle Abhängigkeiten der
 * Stufe sind injizierbar.
 */

const BODY_WITH_SIGNAL =
  "---\ntype: capture\ntags: [db, arch]\n---\n\n# Neu\n\nRedis vs. Postgres — wir wechseln.\n";
const BODY_WITHOUT_SIGNAL =
  "---\ntype: capture\ntags: [db, arch]\n---\n\n# Neu\n\nWir nutzen Postgres.\n";

const EXISTING: CandidateNote[] = [
  { id: "50_decisions/postgres", title: "Postgres", tags: ["db", "arch"], links: [] },
];

function chatResult(text: string): ChatResult {
  return {
    text,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: "stub",
    finishReason: "stop",
  };
}

interface Harness {
  deps: Partial<IngestSynthesisDeps>;
  judge: ReturnType<typeof vi.fn>;
  saved: NewIngestProposal[];
  logs: string[];
}

function harness(opts: {
  mode?: "off" | "prefilter" | "full";
  budgetMs?: number;
  maxJudge?: number;
  notes?: CandidateNote[];
  judgeAnswer?: string;
  judgeThrows?: Error;
  judgeDelayMs?: number;
  resolveJudge?: () => Promise<never>;
  listNotesThrows?: Error;
  now?: () => number;
}): Harness {
  const saved: NewIngestProposal[] = [];
  const logs: string[] = [];
  const judge = vi.fn(async (): Promise<ChatResult> => {
    if (opts.judgeThrows) throw opts.judgeThrows;
    if (opts.judgeDelayMs) {
      await new Promise((r) => setTimeout(r, opts.judgeDelayMs));
    }
    return chatResult(
      opts.judgeAnswer ??
        '{"contradicts": true, "reasoning": "Die neue Notiz kehrt die Entscheidung um."}',
    );
  });

  return {
    judge,
    saved,
    logs,
    deps: {
      config: () => ({
        mode: opts.mode ?? "full",
        budgetMs: opts.budgetMs ?? 5_000,
        maxJudge: opts.maxJudge ?? 3,
      }),
      vaultId: () => "vault-test",
      listNotes: async () => {
        if (opts.listNotesThrows) throw opts.listNotesThrows;
        return opts.notes ?? EXISTING;
      },
      getNote: async (id) => ({ title: id, body: `Body von ${id}` }),
      resolveJudge: opts.resolveJudge ?? (async () => judge),
      saveProposals: async (inputs) => {
        saved.push(...inputs);
        return inputs.map(
          (p, i) =>
            ({
              ...p,
              id: `proposal-${i}`,
              status: "pending",
              evidence: p.evidence ?? null,
              createdAt: new Date().toISOString(),
              decidedAt: null,
            }) as IngestProposal,
        );
      },
      now: opts.now,
      log: (line) => logs.push(line),
    },
  };
}

describe("Ingest-Synthese", () => {
  it("ruft OHNE Vorfilter-Treffer kein LLM auf", async () => {
    const h = harness({});

    const out = await runIngestSynthesis(
      { jobId: "job-1", noteId: "30_captures/urls/neu", body: BODY_WITHOUT_SIGNAL },
      h.deps,
    );

    expect(h.judge).not.toHaveBeenCalled();
    expect(out.judgeCalls).toBe(0);
    expect(out.proposals).toEqual([]);
    // Nichts still verschluckt: der Grund steht im Log …
    expect(out.notices.join(" ")).toMatch(/kein Kontrast-Signal/);
    // … aber er belästigt den Job nicht, weil es der Normalfall ist.
    expect(out.alerts).toEqual([]);
  });

  it("legt bei bejahtem Widerspruch einen pending-Vorschlag ab", async () => {
    const h = harness({});

    const out = await runIngestSynthesis(
      { jobId: "job-2", noteId: "30_captures/urls/neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.judgeCalls).toBe(1);
    expect(out.proposals).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      action: "flag_contradiction",
      sourceNoteId: "30_captures/urls/neu",
      targetNoteId: "50_decisions/postgres",
      vaultId: "vault-test",
      jobId: "job-2",
    });
    expect(h.saved[0]?.rationale).toMatch(/gemeldet, nicht bewertet/);
  });

  it("legt bei verneintem Widerspruch nichts ab", async () => {
    const h = harness({ judgeAnswer: '{"contradicts": false, "reasoning": "passt"}' });

    const out = await runIngestSynthesis(
      { jobId: "job-3", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.judgeCalls).toBe(1);
    expect(out.proposals).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it("bricht bei überschrittenem Zeitbudget ohne Vorschläge ab und benennt es", async () => {
    // Die Uhr springt beim zweiten Blick über die Frist — genau wie eine
    // langsame Vorfilter-Runde auf einem trägen Vault.
    let calls = 0;
    const h = harness({
      budgetMs: 1,
      now: () => {
        calls++;
        return calls === 1 ? 0 : 10_000;
      },
    });

    const out = await runIngestSynthesis(
      { jobId: "job-4", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.proposals).toEqual([]);
    expect(h.judge).not.toHaveBeenCalled();
    expect(out.alerts.join(" ")).toMatch(/Zeitbudget/);
    expect(h.logs.join(" ")).toMatch(/Zeitbudget/);
  });

  it("verwirft eine Judge-Antwort, die nach dem Budget kommt", async () => {
    const h = harness({ budgetMs: 30, judgeDelayMs: 200 });

    const out = await runIngestSynthesis(
      { jobId: "job-5", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.judgeCalls).toBe(1);
    expect(out.proposals).toEqual([]);
    expect(out.alerts.join(" ")).toMatch(/Zeitbudget überschritten/);
  });

  it("wirft nicht, wenn eine Abhängigkeit wirft — und benennt den Ausfall", async () => {
    const h = harness({ listNotesThrows: new Error("Vault unlesbar") });

    const out = await runIngestSynthesis(
      { jobId: "job-6", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.proposals).toEqual([]);
    expect(out.alerts.join(" ")).toMatch(/Stufe abgebrochen: Vault unlesbar/);
  });

  it("zählt einen Judge-Fehler als benannten Ausfall, nicht als Erfolg", async () => {
    const h = harness({ judgeThrows: new Error("Ollama weg") });

    const out = await runIngestSynthesis(
      { jobId: "job-7", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.proposals).toEqual([]);
    expect(out.alerts.join(" ")).toMatch(/Judge-Fehler .*Ollama weg/);
  });

  it("benennt eine unlesbare Judge-Antwort", async () => {
    const h = harness({ judgeAnswer: "Ich denke schon, ja." });

    const out = await runIngestSynthesis(
      { jobId: "job-8", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.proposals).toEqual([]);
    expect(out.alerts.join(" ")).toMatch(/kein lesbares JSON/);
  });

  it("Modus \"prefilter\": kein LLM-Aufruf, obwohl Kandidaten da sind", async () => {
    const h = harness({ mode: "prefilter" });

    const out = await runIngestSynthesis(
      { jobId: "job-9", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(h.judge).not.toHaveBeenCalled();
    expect(out.judgeCalls).toBe(0);
    expect(out.alerts.join(" ")).toMatch(/Modus "prefilter"/);
  });

  it("Modus \"off\": die Stufe tut gar nichts", async () => {
    const h = harness({ mode: "off" });

    const out = await runIngestSynthesis(
      { jobId: "job-10", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.mode).toBe("off");
    expect(out.notices).toEqual([]);
    expect(h.judge).not.toHaveBeenCalled();
  });

  it("deckelt die Judge-Aufrufe pro Job und sagt, was liegen blieb", async () => {
    const notes: CandidateNote[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      title: `n${i}`,
      tags: ["db", "arch"],
      links: [],
    }));
    const h = harness({ maxJudge: 2, notes, judgeAnswer: '{"contradicts": false, "reasoning": "x"}' });

    const out = await runIngestSynthesis(
      { jobId: "job-11", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.judgeCalls).toBe(2);
    expect(out.alerts.join(" ")).toMatch(/über der Obergrenze von 2/);
  });

  it("überspringt den Judge benannt, wenn keine lint-Rolle auflösbar ist", async () => {
    const h = harness({
      resolveJudge: async () => {
        throw new Error("no provider available for role=lint");
      },
    });

    const out = await runIngestSynthesis(
      { jobId: "job-12", noteId: "neu", body: BODY_WITH_SIGNAL },
      h.deps,
    );

    expect(out.judgeCalls).toBe(0);
    expect(out.alerts.join(" ")).toMatch(/Rolle "lint" nicht auflösbar/);
  });

  it("schlägt einen fehlenden Rückverweis vor, ohne zu fragen", async () => {
    const h = harness({
      notes: [
        { id: "50_decisions/postgres", title: "Postgres", tags: [], links: [] },
      ],
    });

    const out = await runIngestSynthesis(
      {
        jobId: "job-13",
        noteId: "30_captures/urls/neu",
        body: "---\ntype: capture\n---\n\n# Neu\n\nSiehe [[50_decisions/postgres]].\n",
      },
      h.deps,
    );

    expect(h.judge).not.toHaveBeenCalled();
    expect(out.proposals).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({
      action: "link",
      targetNoteId: "50_decisions/postgres",
    });
  });
});
