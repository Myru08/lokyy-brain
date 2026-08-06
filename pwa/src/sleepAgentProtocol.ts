import type { SleepRunDto } from "./api.sleepAgent.js";

/**
 * Datenaufbereitung für die Nacht-Protokoll-Ansicht (Story C1).
 *
 * Übersetzt die technischen Rohdaten aus `/api/sleep-agent/runs` in
 * Anzeige-Objekte in ALLTAGSDEUTSCH. Die Zielgruppe hat keinen
 * Programmierhintergrund: aus `karpathy-lint` wird „Vault auf Lücken und
 * Widersprüche geprüft“, aus `150000` wird „2 Minuten 30 Sekunden“.
 *
 * Bewusst in einer eigenen, JSX-freien Datei: das ist die Stelle, die bricht,
 * wenn der Server ein Feld umbenennt oder ein neuer Arbeitsschritt dazukommt —
 * und damit die Stelle, die Tests braucht. Das TSX daneben rendert nur noch.
 *
 * DEFENSIVES LESEN ist Pflicht: jedes Feld kann fehlen, `passStats` kann jede
 * Form haben. Ein unerwarteter Server-Stand darf niemals einen weißen Bildschirm
 * erzeugen, nur einen weniger detaillierten Eintrag.
 */

export type { SleepRunDto } from "./api.sleepAgent.js";

/* ── Anzeige-Typen ──────────────────────────────────────────────────── */

/** Eine berührte Notiz — `id` geht direkt in `onOpenNote`. */
export interface TouchedNote {
  /** ULID oder Pfad; wird unverändert an den Öffnen-Mechanismus gereicht. */
  id: string;
  /** Menschenlesbarer Name (Titel oder Dateiname ohne `.md`). */
  label: string;
}

/** Ein einzelner Arbeitsschritt innerhalb eines Laufs. */
export interface ProtocolAction {
  /** Technischer Pass-Name — nur für Diagnose, nicht als Überschrift. */
  passName: string;
  /** Klartext-Beschreibung dessen, was der Schritt getan hat. */
  label: string;
  /** Anzahl der von diesem Schritt bearbeiteten Notizen. */
  processed: number;
  errors: number;
  /** Freitext-Kommentar des Schritts (technisch, optional eingeblendet). */
  detail: string | null;
  /** Der Schritt ist mit einer Ausnahme abgebrochen. */
  failed: boolean;
  errorMessage: string | null;
  /** Notizen, die dieser Schritt angefasst hat — leer, wenn unbekannt. */
  touchedNotes: TouchedNote[];
}

/** Farbliche Einordnung des Status — die Ansicht mappt das auf Theme-Farben. */
export type StatusTone = "ok" | "warn" | "err" | "muted";

/** Ein Lauf, fertig aufbereitet für die Anzeige. */
export interface ProtocolEntry {
  id: string;
  startedAt: Date | null;
  /** „Heute, 03:00 Uhr“ / „12.07.2026, 03:00 Uhr“ / „Zeitpunkt unbekannt“. */
  startedAtLabel: string;
  /** Dauer in Millisekunden; `null`, solange der Lauf läuft. */
  durationMs: number | null;
  /** „2 Minuten 30 Sekunden“ / „läuft noch“. */
  durationLabel: string;
  statusLabel: string;
  statusTone: StatusTone;
  triggerLabel: string;
  phaseLabel: string;
  notesProcessed: number;
  /** Ein-Satz-Zusammenfassung für die Kartenkopfzeile. */
  summary: string;
  actions: ProtocolAction[];
  /** Vereinigung aller berührten Notizen, entdoppelt, Reihenfolge stabil. */
  touchedNotes: TouchedNote[];
  /**
   * `false` heißt: der Server liefert für diesen Lauf KEINE Notiz-Liste (er
   * speichert bislang nur Zähler). Die Ansicht sagt das ehrlich, statt eine
   * leere Liste als „nichts angefasst“ misszuverstehen.
   */
  touchedNotesKnown: boolean;
  errorMessage: string | null;
}

/* ── Wörterbücher (technisch → Alltagsdeutsch) ──────────────────────── */

/**
 * Arbeitsschritte des Sleep-Agents in Klartext.
 * Quelle der Namen: `packages/core/src/sleep-agent/passes/*.ts` (`name:`).
 * Kommt ein neuer Schritt dazu, greift der Fallback in `describeAction`.
 */
const PASS_LABELS: Record<string, string> = {
  "importance-recompute": "Wichtigkeit der Notizen neu bewertet",
  "spacing-effect-surfacing": "Vergessene Notizen wieder hochgeholt",
  "topic-synthesis": "Themen-Übersichten geschrieben",
  "mem0-classifier": "Neue Erinnerungen zur Prüfung vorgemerkt",
  "synaptic-pruning": "Veraltete Verknüpfungen aufgeräumt",
  "karpathy-lint": "Vault auf Lücken und Widersprüche geprüft",
  "entity-extraction": "Namen, Orte und Firmen erkannt",
  "bi-temporal-validation": "Überholte Zusammenhänge markiert",
  "peer-profile-update": "Personen-Profile aktualisiert",
  "ulid-backfill": "Ältere Notizen mit Kennnummern nachgerüstet",
};

const PHASE_LABELS: Record<string, string> = {
  nrem: "Tiefschlaf",
  rem: "Traumschlaf",
  lint: "Aufräumen",
  dream: "Ideen-Phase",
  manual: "Von Hand",
};

const TRIGGER_LABELS: Record<string, string> = {
  idle: "Automatisch im Leerlauf",
  nightly: "Nachtlauf",
  manual: "Von dir gestartet",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Wartet",
  running: "Läuft gerade",
  completed: "Fertig",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
};

const STATUS_TONES: Record<string, StatusTone> = {
  pending: "warn",
  running: "warn",
  completed: "ok",
  failed: "err",
  cancelled: "muted",
};

/**
 * Schlüssel in `passStats[schritt]`, unter denen eine Liste berührter Notizen
 * stehen KANN. Heute liefert der Server keinen davon (nur Zähler) — die Ansicht
 * ist vorwärtskompatibel, damit sie ohne Änderung aufleuchtet, sobald ein
 * Schritt Pfade mitschreibt. `notes` steht bewusst dabei, wird aber nur als
 * Liste gewertet, wenn es ein Array ist: als String ist es der Freitext-
 * Kommentar des Schritts.
 */
const NOTE_LIST_KEYS = [
  "notePaths",
  "noteIds",
  "touchedNotes",
  "paths",
  "notes",
] as const;

/* ── Formatierung ───────────────────────────────────────────────────── */

/** Deutsche Pluralform ohne Bibliothek: `plural(1,"Notiz","Notizen")`. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Dauer in Alltagsdeutsch. Stunden verschlucken die Sekunden (niemand liest
 * „1 Stunde 5 Minuten 12 Sekunden“), Null-Reste werden weggelassen.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "läuft noch";
  }
  if (ms < 1000) return "unter 1 Sekunde";

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    const head = plural(hours, "Stunde", "Stunden");
    return minutes > 0 ? `${head} ${plural(minutes, "Minute", "Minuten")}` : head;
  }
  if (minutes > 0) {
    const head = plural(minutes, "Minute", "Minuten");
    return seconds > 0
      ? `${head} ${plural(seconds, "Sekunde", "Sekunden")}`
      : head;
  }
  return plural(seconds, "Sekunde", "Sekunden");
}

/** `05.08.2026` — bewusst handgebaut, damit die Ausgabe testbar stabil ist. */
function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** `03:05` in lokaler Zeit — der Nutzer denkt in seiner Uhrzeit, nicht in UTC. */
function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Kalendertag-Differenz in lokaler Zeit (ignoriert Uhrzeit und Zeitzone-Offset). */
function calendarDaysApart(a: Date, b: Date): number {
  const dayA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const dayB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((dayB - dayA) / 86_400_000);
}

/**
 * Startzeitpunkt in Alltagsdeutsch: „Heute, 03:05 Uhr“ / „Gestern, …“ /
 * volles Datum bei älteren Läufen.
 */
export function formatRunStart(
  startedAt: Date | null,
  now: Date = new Date(),
): string {
  if (!startedAt) return "Zeitpunkt unbekannt";
  const daysAgo = calendarDaysApart(startedAt, now);
  const time = `${formatTime(startedAt)} Uhr`;
  if (daysAgo === 0) return `Heute, ${time}`;
  if (daysAgo === 1) return `Gestern, ${time}`;
  return `${formatDate(startedAt)}, ${time}`;
}

/* ── Rohdaten-Lesen (jedes Feld defensiv) ───────────────────────────── */

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `20_topics/ki-agenten.md` → `ki-agenten`. */
function labelFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * Ein Listeneintrag kann ein blanker String (Pfad oder ULID) oder ein Objekt
 * mit `id` / `path` / `title` sein. Alles andere wird verworfen.
 */
function toTouchedNote(raw: unknown): TouchedNote | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return id ? { id, label: labelFromPath(id) } : null;
  }
  if (!isRecord(raw)) return null;

  const id =
    (typeof raw.id === "string" && raw.id) ||
    (typeof raw.path === "string" && raw.path) ||
    null;
  if (!id) return null;

  const label =
    (typeof raw.title === "string" && raw.title.trim()) ||
    (typeof raw.path === "string" && labelFromPath(raw.path)) ||
    labelFromPath(id);
  return { id, label };
}

/** Sucht in einem Schritt-Ergebnis nach einer Liste berührter Notizen. */
function readTouchedNotes(stat: Record<string, unknown>): TouchedNote[] {
  for (const key of NOTE_LIST_KEYS) {
    const value = stat[key];
    if (!Array.isArray(value)) continue;
    const notes = value
      .map(toTouchedNote)
      .filter((n): n is TouchedNote => n !== null);
    if (notes.length > 0) return notes;
  }
  return [];
}

/** Übersetzt einen Pass-Namen; unbekannte Schritte bleiben sichtbar. */
function describeAction(passName: string): string {
  return PASS_LABELS[passName] ?? `Arbeitsschritt „${passName}“`;
}

function toAction(passName: string, rawStat: unknown): ProtocolAction {
  const stat = isRecord(rawStat) ? rawStat : {};
  const error = typeof stat.error === "string" ? stat.error : null;
  return {
    passName,
    label: describeAction(passName),
    processed: asCount(stat.processed),
    errors: asCount(stat.errors),
    detail: typeof stat.notes === "string" ? stat.notes : null,
    failed: error !== null,
    errorMessage: error,
    touchedNotes: readTouchedNotes(stat),
  };
}

/**
 * Reihenfolge der Schritte: zuerst die erfolgreich abgeschlossenen in
 * Ausführungsreihenfolge (`passesCompleted`), danach alles, was nur in
 * `passStats` steht — das sind genau die abgebrochenen Schritte, die sonst
 * unsichtbar blieben.
 */
function collectActions(run: SleepRunDto): ProtocolAction[] {
  const stats = isRecord(run.passStats) ? run.passStats : {};
  const completed = Array.isArray(run.passesCompleted)
    ? run.passesCompleted.filter((n): n is string => typeof n === "string")
    : [];

  const ordered = [...completed];
  for (const key of Object.keys(stats)) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered.map((name) => toAction(name, stats[name]));
}

/** Vereinigt die Notiz-Listen aller Schritte und entdoppelt über die `id`. */
function mergeTouchedNotes(actions: ProtocolAction[]): TouchedNote[] {
  const seen = new Set<string>();
  const merged: TouchedNote[] = [];
  for (const action of actions) {
    for (const note of action.touchedNotes) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      merged.push(note);
    }
  }
  return merged;
}

/** Ein-Satz-Zusammenfassung — die Zeile, die der Nutzer wirklich liest. */
function summarize(notesProcessed: number, actionCount: number): string {
  if (actionCount === 0 && notesProcessed === 0) {
    return "Nichts zu tun — der Vault war schon aufgeräumt";
  }
  const steps = plural(actionCount, "Arbeitsschritt", "Arbeitsschritte");
  if (notesProcessed === 0) {
    return `Keine Notiz verändert · ${steps} geprüft`;
  }
  return `${plural(notesProcessed, "Notiz", "Notizen")} bearbeitet · ${steps}`;
}

/* ── Einstiegspunkt ─────────────────────────────────────────────────── */

/**
 * Wandelt die Server-Läufe in Anzeige-Einträge, neueste zuerst.
 *
 * `now` ist injizierbar, damit „Heute“/„Gestern“ testbar bleibt.
 */
export function toProtocolEntries(
  runs: SleepRunDto[] | null | undefined,
  now: Date = new Date(),
): ProtocolEntry[] {
  if (!Array.isArray(runs)) return [];

  const entries = runs.filter(isRecord).map((raw): ProtocolEntry => {
    const run = raw as SleepRunDto;
    const startedAt = parseDate(run.startedAt);
    const finishedAt = parseDate(run.finishedAt);
    const durationMs =
      startedAt && finishedAt
        ? Math.max(0, finishedAt.getTime() - startedAt.getTime())
        : null;

    const actions = collectActions(run);
    const touchedNotes = mergeTouchedNotes(actions);
    const status = typeof run.status === "string" ? run.status : "";
    const notesProcessed = asCount(run.notesProcessed);

    return {
      id: typeof run.id === "string" ? run.id : "",
      startedAt,
      startedAtLabel: formatRunStart(startedAt, now),
      durationMs,
      durationLabel: formatDuration(durationMs),
      statusLabel: STATUS_LABELS[status] ?? "Unbekannt",
      statusTone: STATUS_TONES[status] ?? "muted",
      triggerLabel:
        TRIGGER_LABELS[
          typeof run.trigger === "string" ? run.trigger : ""
        ] ?? "Unbekannter Auslöser",
      phaseLabel:
        PHASE_LABELS[typeof run.phase === "string" ? run.phase : ""] ??
        "Sonstiges",
      notesProcessed,
      summary: summarize(notesProcessed, actions.length),
      actions,
      touchedNotes,
      touchedNotesKnown: touchedNotes.length > 0,
      errorMessage:
        typeof run.errorMessage === "string" && run.errorMessage
          ? run.errorMessage
          : null,
    };
  });

  // Der Server sortiert bereits `startedAt DESC`; hier wird defensiv
  // nachsortiert, damit die Reihenfolge auch bei gemischten Quellen stimmt.
  return entries.sort((a, b) => {
    const ta = a.startedAt?.getTime() ?? 0;
    const tb = b.startedAt?.getTime() ?? 0;
    return tb - ta;
  });
}
