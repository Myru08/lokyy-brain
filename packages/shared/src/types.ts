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
}

export type PipeType = "youtube" | "voice" | "url" | "crawl" | "unknown";

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
}
