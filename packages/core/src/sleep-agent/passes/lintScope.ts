/**
 * Fork — Geltungsbereich des Karpathy-Lint-Passes.
 *
 * Zwei Probleme aus dem Betrieb (Review-Queue zu gut der Hälfte Fehlalarme):
 *
 * 1. `00_meta/` (Vorlagen mit ABSICHTLICHEN Platzhaltern wie `__GENERATE_ULID__`,
 *    SPEC, Konventionen) und `99_archive/` (inkl. `_trash/`, bewusst abgelegt)
 *    erzeugten schema_drift-, orphan- und duplicate-Befunde, die nach jedem
 *    Erledigen wiederkamen. Sie werden nicht mehr selbst geprüft und zählen
 *    nicht als Dubletten-Partner. Als LINK-ZIEL existieren sie weiter (sonst
 *    würden Links auf archivierte Notizen zu missing_link-Fehlalarmen).
 *    Vgl. `LINK_AUDIT_EXEMPT_PREFIXES` in graphService.ts.
 *
 * 2. Die Dubletten-Suche nahm immer `allNotes.slice(0, 200)`, obwohl der
 *    Kommentar eine Rotation versprach: bei >200 Notizen wurde der Rest nie
 *    geprüft. `dupCheckWindow` wandert jetzt wöchentlich um ein Fenster weiter,
 *    zustandslos aus dem Datum abgeleitet.
 */

export const LINT_EXEMPT_PREFIXES = ["00_meta/", "99_archive/"] as const;

/** True, wenn die Notiz (Vault-relativer Pfad ohne `.md`) nicht gelintet wird. */
export function isLintExempt(noteId: string): boolean {
  const id = noteId.replace(/^\/+/, "");
  return LINT_EXEMPT_PREFIXES.some((p) => id.startsWith(p));
}

const WEEK_MS = 7 * 86_400_000;

/**
 * Wählt das Fenster der Notizen für die Dubletten-Suche dieses Laufs.
 * Sortiert stabil nach id, Start = (Wochenindex × max) mod n, mit Umlauf.
 * Bei n ≤ max kommen alle Notizen dran.
 */
export function dupCheckWindow<T extends { id: string }>(
  notes: readonly T[],
  max: number,
  now: number = Date.now(),
): T[] {
  const sorted = [...notes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = sorted.length;
  if (n <= max) return sorted;
  const start = (Math.floor(now / WEEK_MS) * max) % n;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(sorted[(start + i) % n]!);
  return out;
}
