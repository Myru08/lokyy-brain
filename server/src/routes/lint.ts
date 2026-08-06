import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";

import {
  database,
  lintFindings,
  isLintStatus,
  buildStatements,
  writeFindingCallout,
  removeFindingCallout,
  type LintStatus,
  type LintSeverity,
} from "@lokyy/core";

/**
 * Phase C Wave C1 / Story 3 — `/api/lint/*`.
 *
 *   GET  /api/lint/findings?status=open&kind=orphan  list findings
 *   POST /api/lint/findings/:id/acknowledge          status → acknowledged
 *   POST /api/lint/findings/:id/dismiss              status → dismissed
 *   POST /api/lint/findings/:id/mark-fixed           status → fixed
 *
 * Mutating routes set `resolved_at` to NOW() whenever the new status is
 * terminal (acknowledged / dismissed / fixed) — `open` is the only non-
 * terminal state. The transitions are intentionally loose: a user can
 * reopen a finding by writing back `status=open` via the (still-internal)
 * SQL path, but the public route surface only moves forward.
 */
export const lintRoutes = new Hono();

const TERMINAL_STATUSES: ReadonlySet<LintStatus> = new Set([
  "acknowledged",
  "fixed",
  "dismissed",
]);

const VALID_KINDS = new Set([
  "orphan",
  "contradiction",
  "missing_link",
  "schema_drift",
  "duplicate",
]);

lintRoutes.get("/findings", async (c) => {
  const statusParam = c.req.query("status");
  const kindParam = c.req.query("kind");
  // Opt-in: hängt pro Fund die betroffenen Aussagen (Titel + Exzerpt) an.
  // Standardmäßig aus, damit die bestehende Response-Form unverändert bleibt
  // (`AgentReviewPanel` liest sie); das Lint-Panel setzt das Flag.
  const withStatements = c.req.query("withStatements") === "1";
  const limitRaw = c.req.query("limit");
  const limit = (() => {
    const n = Number(limitRaw ?? "100");
    if (!Number.isFinite(n)) return 100;
    return Math.max(1, Math.min(500, Math.floor(n)));
  })();

  const conditions = [] as ReturnType<typeof eq>[];
  if (statusParam && isLintStatus(statusParam)) {
    conditions.push(eq(lintFindings.status, statusParam));
  }
  if (kindParam && VALID_KINDS.has(kindParam)) {
    conditions.push(eq(lintFindings.kind, kindParam));
  }

  const query = database()
    .select()
    .from(lintFindings)
    .orderBy(desc(lintFindings.detectedAt))
    .limit(limit);

  const rows = await (conditions.length === 0
    ? query
    : conditions.length === 1
      ? query.where(conditions[0]!)
      : query.where(and(...conditions)));

  if (!withStatements) return c.json({ findings: rows });

  // Exzerpte kommen aus der lokalen Arbeitskopie (kein `git pull` pro Notiz —
  // das wären sonst N Netzwerk-Roundtrips für eine reine Listenansicht).
  const enriched = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      statements: await buildStatements(row.noteIds),
    })),
  );
  return c.json({ findings: enriched });
});

async function transitionStatus(
  id: string,
  to: LintStatus,
): Promise<{ ok: true } | { error: string }> {
  const rows = await database()
    .select()
    .from(lintFindings)
    .where(eq(lintFindings.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return { error: "finding not found" };

  const resolvedAt = TERMINAL_STATUSES.has(to) ? new Date() : null;
  await database()
    .update(lintFindings)
    .set({ status: to, resolvedAt })
    .where(eq(lintFindings.id, id));
  return { ok: true };
}

lintRoutes.post("/findings/:id/acknowledge", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "acknowledged");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

lintRoutes.post("/findings/:id/dismiss", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "dismissed");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

lintRoutes.post("/findings/:id/mark-fixed", async (c) => {
  const id = c.req.param("id");
  const result = await transitionStatus(id, "fixed");
  if ("error" in result) return c.json({ error: result.error }, 404);
  return c.json(result);
});

/* ──────────────────────────────────────────────────────────────────────────
 * Warnkasten in der Notiz (Story „Widerspruchs-Warnkasten", Paket B)
 *
 * Ein Fund, den man nur in einem Panel sieht, wird übersehen. Diese beiden
 * Routen schreiben den Fund als Markdown-Callout MITTEN in die betroffene
 * Notiz und nehmen ihn beim Auflösen wieder heraus. Beides läuft über
 * `saveNote` — SPEC-Frontmatter bleibt unangetastet, jeder Schreibvorgang ist
 * ein regulärer gitService-Commit.
 * ────────────────────────────────────────────────────────────────────── */

/** „Beide Aussagen sind in Ordnung" — der Fund war ein Fehlalarm. */
const BOTH_OK = "both_ok";

async function loadFinding(id: string) {
  const rows = await database()
    .select()
    .from(lintFindings)
    .where(eq(lintFindings.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * POST /findings/:id/callout — schreibt (bzw. aktualisiert) den Kasten in
 * allen betroffenen Notizen. Idempotent: ein zweiter Aufruf erzeugt keinen
 * zweiten Kasten, sondern meldet die Notizen als `unchanged`.
 */
lintRoutes.post("/findings/:id/callout", async (c) => {
  const id = c.req.param("id");
  const row = await loadFinding(id);
  if (!row) return c.json({ error: "finding not found" }, 404);

  const statements = await buildStatements(row.noteIds);
  const result = await writeFindingCallout({
    id: row.id,
    kind: row.kind,
    severity: row.severity as LintSeverity,
    message: row.message,
    statements,
  });

  return c.json({ ok: true, ...result });
});

/**
 * POST /findings/:id/resolve — Auflösen mit Entscheidung.
 *
 * Body: `{ "choice": "<noteId>" }` (diese Aussage gilt) oder
 *       `{ "choice": "both_ok" }` (beide Aussagen sind in Ordnung).
 *
 * Eine Auswahl ist PFLICHT: ohne sie wäre „Auflösen" nur ein Löschen des
 * Kastens, und genau das soll die Regel verhindern („Quelle reparieren, nicht
 * nur den Kasten löschen"). Die Entscheidung wandert in `evidence.resolution`,
 * damit im Nachhinein nachvollziehbar bleibt, WARUM der Fund geschlossen ist.
 *
 * Statuslogik: eine gewählte Aussage heißt, die andere Quelle ist zu
 * reparieren → `fixed`. „beide ok" heißt Fehlalarm → `dismissed`.
 *
 * Hinweis zur Atomarität: gitService committet dateiweise, ein Fund über zwei
 * Notizen erzeugt daher zwei Commits. Für den Nutzer ist es eine Aktion; ein
 * echter Multi-File-Commit bräuchte eine neue gitService-API.
 */
lintRoutes.post("/findings/:id/resolve", async (c) => {
  const id = c.req.param("id");
  const row = await loadFinding(id);
  if (!row) return c.json({ error: "finding not found" }, 404);

  const body = await c.req
    .json<{ choice?: string }>()
    .catch((): { choice?: string } => ({}));
  const choice = body.choice;
  if (!choice) {
    return c.json(
      {
        error:
          "choice is required — pass the noteId whose statement holds, or \"both_ok\"",
        options: [...row.noteIds, BOTH_OK],
      },
      400,
    );
  }
  if (choice !== BOTH_OK && !row.noteIds.includes(choice)) {
    return c.json(
      { error: "choice must be one of the affected notes or \"both_ok\"", options: [...row.noteIds, BOTH_OK] },
      400,
    );
  }

  const removal = await removeFindingCallout(row.id, row.noteIds);

  const status: LintStatus = choice === BOTH_OK ? "dismissed" : "fixed";
  const existingEvidence =
    row.evidence && typeof row.evidence === "object"
      ? (row.evidence as Record<string, unknown>)
      : {};

  await database()
    .update(lintFindings)
    .set({
      status,
      resolvedAt: new Date(),
      evidence: {
        ...existingEvidence,
        resolution: { choice, at: new Date().toISOString() },
      },
    })
    .where(eq(lintFindings.id, row.id));

  return c.json({ ok: true, status, choice, ...removal });
});
