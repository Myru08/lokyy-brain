/**
 * Geteiltes Datenmodell zwischen Server und PWA.
 *
 * Eine Notiz ist immer eine Markdown-Datei im Vault-Working-Clone.
 * Es gibt keine separate DB — die `.md`-Dateien (und damit Forgejo) sind
 * die Wahrheit. Alles hier ist abgeleitet oder Transportformat.
 */

/** Eine einzelne Notiz. `path` ist relativ zum Vault-Root, z.B. "pai/hermes.md". */
export interface Note {
  /** stabile id = path ohne ".md", z.B. "pai/hermes" */
  id: string;
  /** Dateipfad relativ zum Vault-Root */
  path: string;
  /** Anzeigetitel — erste H1 oder Dateiname */
  title: string;
  /** roher Markdown-Inhalt */
  body: string;
  /** aus #tags im Body geparst */
  tags: string[];
  /** Wikilink-Ziele (Titel/ids) aus [[...]] */
  links: string[];
  /**
   * Alternative Namen aus dem Frontmatter-Feld `aliases: [Foo, Bar]`.
   * Jeder Alias macht die Note via `[[Alias]]` auflösbar — zusätzlich
   * zum Titel und zur id. Leeres Array, wenn das Frontmatter-Feld fehlt
   * oder kein Array ist.
   */
  aliases: string[];
  /** ISO-Timestamp des letzten Commits, der die Datei berührt hat */
  updatedAt: string;
}

/** Leichtgewichtiger Eintrag für Listen/Sidebar — ohne `body`. */
export type NoteSummary = Omit<Note, "body">;

/**
 * Knoten im Datei-Baum. Bildet die Ordnerstruktur des Vaults ab —
 * Ordner können verschachtelt sein, Notizen sind Blätter.
 */
export interface TreeNode {
  type: "folder" | "note";
  /** Anzeigename: Ordnername bzw. Notiztitel */
  name: string;
  /** Ordnerpfad bzw. Notiz-id (Pfad ohne ".md"), relativ zum Vault-Root */
  path: string;
  /** nur bei Ordnern befüllt */
  children: TreeNode[];
}

/** Knoten im Wissensgraphen. */
export interface GraphNode {
  id: string;
  title: string;
  tags: string[];
}

/** Gerichtete Kante: `source` verlinkt `target` per [[Wikilink]]. */
export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Was die PWA über die Web-Share-Target-Route schickt. */
export interface SharePayload {
  /** Klartext / URL aus dem Share */
  text?: string;
  url?: string;
  title?: string;
  /** optionale Datei (z.B. Sprachnachricht) als base64 */
  file?: { name: string; mime: string; dataBase64: string };
  /**
   * Optionaler Ziel-Ordner für den Pipe-Output (Story 4b).
   *
   * Pfad relativ zum Vault-Root, ohne führenden/abschließenden Slash, z.B.
   * `"30_captures"` oder `"30_captures/research/2026"`. Pipe-Handler
   * schreiben dann nach `${targetFolder}/${typeSubfolder}/…`. Fehlt das
   * Feld, fällt der Handler auf `default_import_folder` aus den
   * System-Settings zurück und am Ende auf `"30_captures"`.
   */
  targetFolder?: string;
  /**
   * Voice-Pipe (Whisper). Pfad zur bereits im Vault liegenden Audio-Datei,
   * relativ zum Vault-Root (z.B. `30_captures/voice/2026-05-27-01H….webm`).
   * Wird von der Route gesetzt, NACHDEM die Audio-Bytes via gitService
   * committet wurden. Der voiceHandler liest die Datei von Disk und postet
   * sie an die OpenAI-Whisper-API.
   */
  audioPath?: string;
  /**
   * Voice-Pipe (Whisper). Optionaler ISO-639-1-Sprachcode (z.B. "de",
   * "en"). Fehlt das Feld, lässt Whisper die Sprache automatisch erkennen.
   */
  language?: string;
  /**
   * Datei-/Ordner-Import (Issue #63). Der vom Client gemeldete Pfad der
   * Datei RELATIV zum gewählten Ordner (`webkitRelativePath`), bereits
   * saniert — nur zur Herkunfts-Dokumentation im Frontmatter.
   *
   * Das Ziel im Vault steckt NICHT hier, sondern in `targetFolder`: die
   * Route baut `targetFolder = <Zielordner>/<sanierte Unterordner>` zusammen,
   * damit die Handler weiterhin nur ein Feld lesen müssen.
   */
  relativePath?: string;
}

/**
 * Pipe-Typen. `text` und `pdf` (Issue #63) kommen aus dem Datei-/Ordner-Import
 * — sie sind die einzigen Typen, deren Quelle eine hochgeladene Datei statt
 * einer URL ist. Bilder/sonstige Binaerdateien haben bewusst KEINEN Typ: sie
 * passen nicht in den Markdown-Contract und bekommen einen eigenen Upload-Weg.
 */
export type PipeType =
  | "youtube"
  | "voice"
  | "url"
  | "crawl"
  | "text"
  | "pdf"
  | "unknown";

export type PipeStatus = "queued" | "processing" | "done" | "error";

/**
 * Aktiver Import aus dem Import-Panel (nicht über das Web Share Target,
 * sondern bewusst angestoßen). `type` ist optional — fehlt er, erkennt
 * die Pipe-Queue den Typ selbst.
 *
 * `targetFolder` (Story 4b) überschreibt den `default_import_folder` aus
 * den System-Settings für diesen einen Import. Format: Pfad relativ zum
 * Vault-Root, ohne führenden/abschließenden Slash.
 */
export interface ImportRequest {
  url: string;
  type?: PipeType;
  targetFolder?: string;
}

/**
 * Eine benannt abgewiesene Datei aus `POST /api/pipes/files` (Issue #63).
 *
 * Anti-Regel der Story: kein Dateityp wird still verschluckt. Alles, was
 * nicht importiert wurde, steht mit Grund in dieser Liste — es gibt keinen
 * stillen Zähler und keine verschluckte Datei.
 */
export interface FileImportRejection {
  /** Dateiname wie vom Client gemeldet (bzw. `relativePath`, wenn vorhanden). */
  name: string;
  /** Klartext-Grund, direkt anzeigbar. */
  reason: string;
}

/**
 * Antwort von `POST /api/pipes/files` (Issue #63).
 *
 * 202 mit mindestens einem Job, wenn etwas akzeptiert wurde; 400 mit
 * `error` + derselben `rejected`-Liste, wenn gar keine verwertbare Datei
 * dabei war (die Gründe bleiben also auch im Fehlerfall sichtbar).
 */
export interface FileImportResponse {
  jobs: PipeJob[];
  rejected: FileImportRejection[];
  /** nur im 400-Fall gesetzt */
  error?: string;
  /** nur im 400-Fall gesetzt: menschenlesbare Begründung */
  message?: string;
}

/**
 * Was die PWA bei `GET /api/settings/import-defaults` zurückbekommt.
 *
 * `defaultImportFolder` ist der vom Nutzer in den System-Settings
 * gepflegte Ziel-Ordner für aktive Pipe-Imports. Fehlt der Wert in der
 * Datenbank (z.B. solange der Settings-Agent aus Wave 4a noch nicht
 * deployed ist), antwortet der Server mit `"30_captures"`.
 */
export interface ImportDefaults {
  defaultImportFolder: string;
}

/** Ein Pipe-Job in der Queue. */
export interface PipeJob {
  id: string;
  type: PipeType;
  status: PipeStatus;
  payload: SharePayload;
  /** id der erzeugten Notiz, sobald fertig */
  resultNoteId?: string;
  error?: string;
  /**
   * Hinweis zu einem ERFOLGREICHEN Job (Issue #63). Der Job ist `done`, die
   * Notiz liegt im Vault — aber es gibt etwas zu sagen, das kein Fehler ist.
   * Aktueller Fall: ein PDF ohne Textebene (Scan) erzeugt eine leere Notiz;
   * ohne diesen Hinweis stünde der Nutzer vor einer leeren Datei ohne Grund.
   */
  notice?: string;
  createdAt: string;
}

/**
 * Rückgabewert eines Pipe-Handlers: die fertige Notiz, die der Server
 * dann in den Vault committet.
 */
export interface PipeResult {
  /** gewünschter Dateipfad relativ zum Vault-Root, z.B. "inbox/karpathy.md" */
  path: string;
  /** vollständiger Markdown-Inhalt inkl. Frontmatter */
  body: string;
  /**
   * Optionaler Hinweis, der den Job zwar erfolgreich abschließt, aber
   * erklärungsbedürftig macht (siehe `PipeJob.notice`). Die Queue reicht ihn
   * unverändert an den Job durch.
   */
  notice?: string;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Ingest-Time-Synthese (Issue #67)
 *
 * Ein Import legte bisher eine isolierte Notiz an; der Abgleich mit dem
 * bestehenden Wissen passierte erst im Nachtlauf. Die Synthese-Stufe läuft
 * direkt im Import-Pfad und legt VORSCHLÄGE ab — geschrieben wird erst nach
 * Freigabe. Die erfasste Notiz selbst wird unverändert sofort committet: ein
 * Handy-Share soll nicht in der Queue hängen, bis jemand die App öffnet.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Was ein Vorschlag tun würde.
 *
 * `flag_contradiction` MELDET nur, es wertet nichts ab — konsistent zum
 * Nachtlauf (Entscheidung Oliver, 2026-09-26). `create_note` meint eine
 * ZUSÄTZLICH vorgeschlagene Notiz, nie die importierte Quelle.
 */
export const INGEST_PROPOSAL_ACTIONS = [
  "create_note",
  "append_to_note",
  "link",
  "flag_contradiction",
  "merge",
  "skip",
] as const;
export type IngestProposalAction = (typeof INGEST_PROPOSAL_ACTIONS)[number];

/**
 * Lebenslauf eines Vorschlags. Append-only Log: die Zeile wird nie gelöscht,
 * nur ihr Status wandert weiter (`pending` → `approved`/`rejected` →
 * `applied`/`failed`).
 */
export const INGEST_PROPOSAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "applied",
  "failed",
] as const;
export type IngestProposalStatus = (typeof INGEST_PROPOSAL_STATUSES)[number];

/** Ein einzelner Synthese-Vorschlag, wie ihn API und PWA sehen. */
export interface IngestProposal {
  id: string;
  /** #66 — von Anfang an mitgeschrieben, damit die Tabelle nicht vault-blind wächst. */
  vaultId: string;
  /** Welcher Import-Lauf den Vorschlag erzeugt hat. */
  jobId: string;
  action: IngestProposalAction;
  /** Die neu importierte Notiz (path-id, ohne ".md"). */
  sourceNoteId: string;
  /** Die betroffene bestehende Notiz — `null`, wenn keine. */
  targetNoteId: string | null;
  /** Warum. Anzeigbar, in der Sprache des Nutzers. */
  rationale: string;
  status: IngestProposalStatus;
  /** Vorfilter-Treffer, Judge-Antwort, Fehlergrund beim Anwenden. */
  evidence: unknown;
  /** ISO-Timestamps. */
  createdAt: string;
  decidedAt: string | null;
}

/** Antwort von `GET /api/ingest/proposals?status=pending`. */
export interface IngestProposalsResponse {
  proposals: IngestProposal[];
}

/** Body von `POST /api/ingest/proposals/apply` — Proposal-IDs. */
export interface IngestApplyRequest {
  approved: string[];
  rejected: string[];
}

/**
 * Antwort von `POST /api/ingest/proposals/apply`.
 *
 * `skipped` ist Pflichtteil des Vertrags: eine unbekannte ID, ein bereits
 * entschiedener Vorschlag oder eine nicht anwendbare Aktion landen dort MIT
 * Grund — nie als stiller Zähler.
 */
export interface IngestApplyResponse {
  applied: IngestProposal[];
  skipped: Array<{ id: string; reason: string }>;
}
