import type { IngestProposal } from "@lokyy/shared";

import { parseLinks, parseTags, parseTitle } from "../graph/graphService.js";
import { getNote, listNotes } from "../notes/notesService.js";
import { isHandsOffZone } from "../sleep-agent/rawGuard.js";
import { LlmRouter } from "../llm/router.js";
import { getLlmRouting } from "../llm/configStore.js";
import { LlmUnavailable } from "../llm/errors.js";
import { indexVaultId } from "../util/coreConfig.js";
import {
  ingestSynthesisConfig,
  type IngestSynthesisConfig,
} from "./config.js";
import { prefilter, type CandidateNote, type PrefilterHit } from "./prefilter.js";
import { judgeContradiction, type JudgeChat } from "./judge.js";
import {
  insertIngestProposals,
  type NewIngestProposal,
} from "./proposalStore.js";

/**
 * Issue #67 — die Synthese-Stufe der Import-Pipes.
 *
 * Sie läuft in `pipeQueue.drain()` NACH dem Handler und NACH `save()`, sieht
 * den Body der frisch importierten Notiz und legt Vorschläge als `pending` ab.
 * Geschrieben wird an dieser Stelle NICHTS in den Vault — das passiert erst
 * über `applyIngestProposals`, nach Freigabe.
 *
 * Drei harte Regeln, in dieser Reihenfolge:
 *
 *   1. **Nie blockieren.** Jeder teure Schritt prüft vorher das Restbudget.
 *      Ist es aufgebraucht, endet die Stufe — mit den Vorschlägen, die bis
 *      dahin fertig waren, im Regelfall also keinen.
 *   2. **Nie den Import killen.** Diese Funktion wirft per Vertrag nicht. Der
 *      Aufrufer fängt zusätzlich (Gürtel und Hosenträger), weil der Capture
 *      wichtiger ist als die Synthese.
 *   3. **Nichts still verschlucken.** Jeder Abbruch, jeder übersprungene
 *      Vorschlag und jeder Judge-Fehler steht in `notices` und im Log.
 *
 * Alle Abhängigkeiten sind injizierbar — so ist prüfbar, was an der Stufe
 * zählt (kein LLM-Aufruf ohne Vorfilter-Treffer, Budget, Fehlertoleranz), ohne
 * Vault, DB oder Ollama.
 */

export interface IngestSynthesisInput {
  /** Der Pipe-Job, der die Notiz erzeugt hat. */
  jobId: string;
  /** path-id der neuen Notiz (Pfad ohne ".md"). */
  noteId: string;
  /** Voller Markdown-Body inkl. Frontmatter, wie der Handler ihn lieferte. */
  body: string;
}

export interface IngestSynthesisOutcome {
  proposals: IngestProposal[];
  /** Benannte Abbrüche, Auslassungen, Fehler — vollständig, fürs Log. */
  notices: string[];
  /**
   * Die Teilmenge von `notices`, die an DIESEM Job sichtbar werden muss: alles,
   * wo zu dieser Notiz Arbeit weggefallen ist (Budget, Deckel, Judge-Fehler,
   * abgeschalteter Judge trotz Kandidaten). „Kein Kontrast-Signal" gehört nicht
   * dazu — das ist der Normalfall und würde jeden Import mit Rauschen versehen.
   */
  alerts: string[];
  /** Tatsächliche LLM-Aufrufe. In Tests der Beweis für „kein Judge". */
  judgeCalls: number;
  mode: IngestSynthesisConfig["mode"];
}

export interface IngestSynthesisDeps {
  config: () => IngestSynthesisConfig;
  vaultId: () => string;
  listNotes: () => Promise<CandidateNote[]>;
  getNote: (id: string) => Promise<{ title: string; body: string } | null>;
  /** `null`, wenn keine `lint`-Rolle konfiguriert ist (dann: kein Judge). */
  resolveJudge: () => Promise<JudgeChat | null>;
  saveProposals: (inputs: NewIngestProposal[]) => Promise<IngestProposal[]>;
  now: () => number;
  log: (line: string) => void;
}

/** Produktiv-Verdrahtung. Tests überschreiben einzelne Felder. */
export function defaultSynthesisDeps(): IngestSynthesisDeps {
  return {
    config: ingestSynthesisConfig,
    vaultId: indexVaultId,
    listNotes: async () =>
      (await listNotes())
        // Die `RAW/_…`-Hände-weg-Zone wird nie Ziel eines Vorschlags.
        .filter((n) => !isHandsOffZone(n.id))
        .map((n) => ({
          id: n.id,
          title: n.title,
          tags: n.tags ?? [],
          links: n.links ?? [],
        })),
    getNote: async (id) => {
      const note = await getNote(id);
      return note ? { title: note.title, body: note.body } : null;
    },
    resolveJudge: async () => {
      const router = new LlmRouter(await getLlmRouting());
      const provider = router.getProvider("lint");
      return provider.chat ? provider.chat.bind(provider) : null;
    },
    saveProposals: insertIngestProposals,
    now: () => Date.now(),
    log: (line) => console.warn(`[ingest-synthesis] ${line}`),
  };
}

/** Frontmatter-`tags:`-Liste — Inline-`#tags` deckt `parseTags` ab. */
function frontmatterTags(body: string): string[] {
  const fence = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fence) return [];
  const line = fence[1].match(/^tags:\s*(.*)$/m);
  if (!line) return [];
  const inline = line[1].trim();
  if (inline.startsWith("[")) {
    return inline
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter((t) => t !== "");
  }
  // Block-Form: nachfolgende `- tag`-Zeilen.
  const rest = fence[1].slice(fence[1].indexOf(line[0]) + line[0].length);
  const out: string[] = [];
  for (const l of rest.split(/\r?\n/)) {
    const m = l.match(/^\s*-\s*(.+)$/);
    if (!m) break;
    out.push(m[1].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

export async function runIngestSynthesis(
  input: IngestSynthesisInput,
  overrides: Partial<IngestSynthesisDeps> = {},
): Promise<IngestSynthesisOutcome> {
  // Nur GESETZTE Overrides überschreiben die Produktiv-Verdrahtung: ein
  // `{ now: undefined }` aus einem Aufrufer darf nicht die Uhr abschalten.
  const deps: IngestSynthesisDeps = {
    ...defaultSynthesisDeps(),
    ...(Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    ) as Partial<IngestSynthesisDeps>),
  };
  const notices: string[] = [];
  const alerts: string[] = [];
  let judgeCalls = 0;
  let mode: IngestSynthesisConfig["mode"] = "full";

  /** `quiet` = nur ins Log, nicht an den Job. Default ist sichtbar. */
  const note = (line: string, opts: { quiet?: boolean } = {}): void => {
    notices.push(line);
    if (!opts.quiet) alerts.push(line);
    deps.log(`job=${input.jobId} note=${input.noteId} — ${line}`);
  };

  try {
    const cfg = deps.config();
    mode = cfg.mode;
    if (cfg.mode === "off") {
      return { proposals: [], notices, alerts, judgeCalls, mode };
    }

    const deadline = deps.now() + cfg.budgetMs;
    const budgetLeft = (): boolean => deps.now() < deadline;

    if (!budgetLeft()) {
      note(`Zeitbudget (${cfg.budgetMs} ms) schon vor dem Vorfilter aufgebraucht — keine Vorschläge.`);
      return { proposals: [], notices, alerts, judgeCalls, mode };
    }

    // ── Vorfilter (reiner Code) ──────────────────────────────────────────
    const notes = await deps.listNotes();
    const sourceTitle = parseTitle(input.body, `${input.noteId}.md`);
    const result = prefilter({
      sourceNoteId: input.noteId,
      sourceTitle,
      sourceBody: input.body,
      sourceTags: [
        ...new Set([...parseTags(input.body), ...frontmatterTags(input.body)]),
      ],
      sourceLinks: parseLinks(input.body),
      notes,
    });

    const pending: NewIngestProposal[] = [];
    const vaultId = deps.vaultId();

    for (const hit of result.linkHits) {
      pending.push({
        vaultId,
        jobId: input.jobId,
        action: "link",
        sourceNoteId: input.noteId,
        targetNoteId: hit.noteId,
        rationale:
          `Die neue Notiz verweist auf „${hit.noteTitle}", dort fehlt der ` +
          `Rückverweis. Vorschlag: Rückverweis ergänzen.`,
        evidence: { prefilter: hit, reason: "wikilink-ohne-rückverweis" },
      });
    }

    // ── Judge (LLM, nur für Kandidaten) ──────────────────────────────────
    if (result.judgeHits.length === 0) {
      if (result.signals.length === 0) {
        note("Vorfilter: kein Kontrast-Signal im Text — kein LLM-Aufruf.", {
          quiet: true,
        });
      } else {
        note(
          `Vorfilter: Kontrast-Signale (${result.signals.join(", ")}), aber keine ` +
            `bezogene bestehende Notiz — kein LLM-Aufruf.`,
          { quiet: true },
        );
      }
    } else if (cfg.mode === "prefilter") {
      note(
        `Modus "prefilter": ${result.judgeHits.length} Kandidat(en) NICHT geprüft ` +
          `(kein LLM-Aufruf, LOKYY_INGEST_SYNTHESIS=prefilter).`,
      );
    } else {
      const judge = await resolveJudgeSafely(deps, note);
      if (judge) {
        const candidates = result.judgeHits.slice(0, cfg.maxJudge);
        if (result.judgeHits.length > candidates.length) {
          note(
            `${result.judgeHits.length - candidates.length} Kandidat(en) über der ` +
              `Obergrenze von ${cfg.maxJudge} Judge-Aufrufen — nicht geprüft.`,
          );
        }
        for (const hit of candidates) {
          if (!budgetLeft()) {
            note(
              `Zeitbudget (${cfg.budgetMs} ms) überschritten — restliche ` +
                `Kandidaten nicht geprüft.`,
            );
            break;
          }
          const proposal = await judgeOne({
            deps,
            note,
            judge,
            hit,
            sourceTitle,
            sourceBody: input.body,
            remainingMs: deadline - deps.now(),
            onCall: () => {
              judgeCalls++;
            },
          });
          if (proposal) {
            pending.push({
              vaultId,
              jobId: input.jobId,
              action: "flag_contradiction",
              sourceNoteId: input.noteId,
              targetNoteId: hit.noteId,
              rationale: proposal.rationale,
              evidence: {
                prefilter: hit,
                signals: result.signals,
                judge: proposal.verdict,
              },
            });
          }
        }
      }
    }

    if (pending.length === 0) {
      return { proposals: [], notices, alerts, judgeCalls, mode };
    }
    const proposals = await deps.saveProposals(pending);
    return { proposals, notices, alerts, judgeCalls, mode };
  } catch (err) {
    // AC#8: die Stufe wirft nie. Ein Fehler hier kostet Vorschläge, nie den
    // Capture — und er wird benannt, nicht geschluckt.
    note(
      `Stufe abgebrochen: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { proposals: [], notices, alerts, judgeCalls, mode };
  }
}

/** Judge-Provider auflösen. Fehlende `lint`-Rolle ist kein Fehler, aber benannt. */
async function resolveJudgeSafely(
  deps: IngestSynthesisDeps,
  note: (line: string) => void,
): Promise<JudgeChat | null> {
  try {
    const judge = await deps.resolveJudge();
    if (!judge) {
      note("Judge übersprungen: Provider der Rolle \"lint\" kann nicht chatten.");
      return null;
    }
    return judge;
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      note(
        "Judge übersprungen: keine LLM-Rolle \"lint\" konfiguriert — nur Vorfilter.",
      );
    } else {
      note(
        `Judge übersprungen: Rolle "lint" nicht auflösbar (${
          err instanceof Error ? err.message : String(err)
        }).`,
      );
    }
    return null;
  }
}

/**
 * Ein Kandidat, ein Judge-Aufruf. Der Aufruf selbst läuft gegen das
 * Restbudget: antwortet der Provider nicht rechtzeitig, gibt diese Funktion
 * auf (der Aufruf selbst läuft im Hintergrund aus — `chat` kennt kein Abort).
 */
async function judgeOne(args: {
  deps: IngestSynthesisDeps;
  note: (line: string) => void;
  judge: JudgeChat;
  hit: PrefilterHit;
  sourceTitle: string;
  sourceBody: string;
  remainingMs: number;
  onCall: () => void;
}): Promise<{ rationale: string; verdict: unknown } | null> {
  const { deps, note, judge, hit } = args;
  try {
    const target = await deps.getNote(hit.noteId);
    if (!target) {
      note(`Kandidat ${hit.noteId} nicht lesbar — übersprungen.`);
      return null;
    }

    args.onCall();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(1, args.remainingMs));
    });
    let verdict: Awaited<ReturnType<typeof judgeContradiction>> | "timeout";
    try {
      verdict = await Promise.race([
        judgeContradiction(judge, {
          sourceTitle: args.sourceTitle,
          sourceBody: args.sourceBody,
          targetTitle: target.title,
          targetBody: target.body,
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (verdict === "timeout") {
      note(
        `Zeitbudget überschritten während der Prüfung gegen ${hit.noteId} — ` +
          `Antwort verworfen.`,
      );
      return null;
    }
    if (verdict === null) {
      note(`Judge-Antwort zu ${hit.noteId} war kein lesbares JSON — verworfen.`);
      return null;
    }
    if (!verdict.contradicts) return null;

    return {
      rationale:
        `Widerspruch zu „${hit.noteTitle}": ${verdict.reasoning} ` +
        `(gemeldet, nicht bewertet.)`,
      verdict,
    };
  } catch (err) {
    note(
      `Judge-Fehler zu ${hit.noteId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
