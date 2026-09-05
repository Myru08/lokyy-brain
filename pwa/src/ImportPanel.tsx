import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, InputHTMLAttributes } from "react";
import type { PipeJob, PipeType, TreeNode } from "@lokyy/shared";
import {
  X,
  Globe,
  Youtube,
  Network,
  Sparkles,
  Loader2,
  Check,
  AlertTriangle,
  ArrowUpRight,
  Folder,
  Mic,
  Link as LinkIcon,
  Files,
  FileUp,
  FolderUp,
  Ban,
  Trash2,
} from "lucide-react";
import { api } from "./api.js";
import type { FileImportRejection, FileImportResponse } from "./api.js";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";
import { VoiceRecorder } from "./VoiceRecorder.js";

type Tab = "url" | "files" | "voice";

const FALLBACK_FOLDER = "30_captures";

/* ══════════════════════════════════════════════════════════════════════════
 * Datei-/Ordner-Import — Sammel-Logik
 *
 * Bewusst als reine Funktionen neben der Komponente und exportiert: das
 * rekursive Auslesen gedroppter Ordner ist der Teil, den man nicht
 * anklicken kann und der in jedem Browser anders schiefgeht. Er gehört
 * unter Test, nicht in einen Event-Handler vergraben.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Eine ausgewählte Datei samt ihrem Pfad innerhalb der Auswahl. */
export interface SelectedFile {
  file: File;
  relativePath: string;
}

/**
 * Kann dieser Browser ein VERZEICHNIS auswählen?
 *
 * Feature-Probe statt User-Agent-Schnüffelei: `webkitdirectory` existiert
 * auf dem Desktop, auf iOS Safari und Android-Browsern nicht. Wo es fehlt,
 * wird der Ordner-Knopf gar nicht erst angeboten — ein Knopf, der nichts
 * tut, ist schlimmer als keiner.
 */
export function supportsDirectoryPicker(): boolean {
  if (typeof document === "undefined") return false;
  return "webkitdirectory" in document.createElement("input");
}

/** `.DS_Store`, `.git/…` & Co. — Systemkram, den niemand importieren will. */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * FileList (Datei- oder Ordner-Dialog) → Vertragsform.
 *
 * `webkitRelativePath` ist beim Ordner-Dialog gesetzt und enthält den
 * gewählten Ordnernamen als erstes Segment; bei Einzeldateien ist es leer.
 * Genau dieser Wert geht als `relativePath` an den Server.
 */
export function filesFromFileList(
  list: ArrayLike<File> | null | undefined,
): SelectedFile[] {
  const out: SelectedFile[] = [];
  if (!list) return out;
  for (let i = 0; i < list.length; i += 1) {
    const file = list[i];
    if (!file) continue;
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const segments = rel ? rel.split("/") : [file.name];
    if (segments.some(isHiddenName)) continue;
    out.push({ file, relativePath: rel });
  }
  return out;
}

/* Minimal-Sicht auf die non-standard FileSystem-Entry-API. Nicht in
 * @types/dom, und die Vollform brauchen wir nicht. */
interface EntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      ok: (entries: EntryLike[]) => void,
      err?: (e: unknown) => void,
    ) => void;
  };
}

function entryToFile(entry: EntryLike): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof entry.file !== "function") return resolve(null);
    try {
      entry.file(
        (f) => resolve(f),
        () => resolve(null),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Alle Kinder eines Verzeichnisses lesen.
 *
 * Chrome liefert pro `readEntries`-Aufruf höchstens ~100 Einträge und
 * markiert das Ende mit einem LEEREN Array. Ein einzelner Aufruf
 * verschluckt bei größeren Ordnern also stillschweigend den Rest — deshalb
 * die Schleife. Die Obergrenze ist eine Reißleine gegen einen Reader, der
 * nie leer antwortet.
 */
async function readAllEntries(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader?.();
  if (!reader) return [];
  const out: EntryLike[] = [];
  for (let guard = 0; guard < 10_000; guard += 1) {
    const batch = await new Promise<EntryLike[]>((resolve) => {
      try {
        reader.readEntries(
          (entries) => resolve(entries ?? []),
          () => resolve([]),
        );
      } catch {
        resolve([]);
      }
    });
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

/**
 * Gedroppte Dateien UND Ordner einsammeln.
 *
 * `dataTransfer.files` allein liefert bei einem Ordner nichts Brauchbares —
 * dafür braucht es `webkitGetAsEntry()`. Die Einträge werden SYNCHRON
 * gegriffen, bevor irgendwas awaited wird: die Item-Liste ist nach dem
 * Event-Handler tot. Kennt der Browser die Entry-API nicht, bleibt der
 * Datei-Fall über `dataTransfer.files` erhalten.
 */
export async function collectDroppedFiles(
  dt: DataTransfer,
): Promise<{ files: SelectedFile[]; skippedHidden: number }> {
  const items = dt?.items
    ? Array.from(dt.items as unknown as ArrayLike<DataTransferItem>)
    : [];
  const entries = items
    .filter((it) => it.kind === "file")
    .map((it) => {
      const get = (it as DataTransferItem & {
        webkitGetAsEntry?: () => EntryLike | null;
      }).webkitGetAsEntry;
      return typeof get === "function" ? get.call(it) : null;
    })
    .filter((e): e is EntryLike => Boolean(e));

  if (entries.length === 0) {
    const plain = filesFromFileList(dt?.files as ArrayLike<File> | undefined);
    const total = dt?.files?.length ?? 0;
    return { files: plain, skippedHidden: Math.max(0, total - plain.length) };
  }

  const files: SelectedFile[] = [];
  let skippedHidden = 0;

  const walk = async (entry: EntryLike, prefix: string): Promise<void> => {
    if (isHiddenName(entry.name)) {
      skippedHidden += 1;
      return;
    }
    if (entry.isFile) {
      const file = await entryToFile(entry);
      if (file) {
        files.push({
          file,
          relativePath: prefix ? `${prefix}/${entry.name}` : "",
        });
      }
      return;
    }
    if (entry.isDirectory) {
      const next = prefix ? `${prefix}/${entry.name}` : entry.name;
      for (const child of await readAllEntries(entry)) {
        await walk(child, next);
      }
    }
  };

  for (const entry of entries) await walk(entry, "");
  return { files, skippedHidden };
}

/**
 * Auswahl in Anfragen aufteilen, die der Server noch annimmt.
 *
 * Wer 500 Dateien wählt, darf nicht in einen einzigen Multipart-Body
 * laufen — der Server hat Obergrenzen pro Anfrage und weist dann ALLES ab.
 * Eine einzelne Datei über dem Byte-Budget fährt allein los, statt still
 * unter den Tisch zu fallen: ob sie zu groß ist, entscheidet der Server und
 * sagt es benannt.
 */
export function planUploadBatches<T extends { file: { size?: number } }>(
  files: T[],
  limits: { maxFiles: number; maxBytes: number },
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const entry of files) {
    const size = entry.file.size ?? 0;
    const full =
      current.length > 0 &&
      (current.length >= limits.maxFiles || bytes + size > limits.maxBytes);
    if (full) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Anfrage-Budget. Bewusst konservativ: lieber mehrere kleine Anfragen als
 * eine, die am Reverse-Proxy oder an der Server-Obergrenze zerschellt.
 */
const UPLOAD_LIMITS = { maxFiles: 20, maxBytes: 16 * 1024 * 1024 };

/** Wie viele Zeilen der Auswahl-Liste gerendert werden. Der Rest wird gezählt. */
const VISIBLE_ROWS = 25;

type UploadState = "ready" | "uploading" | "queued" | "rejected" | "failed";

interface UploadEntry extends SelectedFile {
  /** stabil über Neuzuordnungen hinweg */
  key: string;
  state: UploadState;
  /** Grund bei `rejected` / `failed` */
  reason?: string;
}

const UPLOAD_LABEL: Record<UploadState, { label: string; color: string }> = {
  ready: { label: "bereit", color: C.textFaint },
  uploading: { label: "wird übertragen…", color: C.gold },
  queued: { label: "in Warteschlange", color: C.ok },
  rejected: { label: "abgewiesen", color: C.err },
  failed: { label: "fehlgeschlagen", color: C.err },
};

/** Lesbare Fehlermeldung statt eines rohen Netzwerk-/HTTP-Fehlers. */
function readableUploadError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 413) {
    return "Zu groß für den Server — weniger oder kleinere Dateien auf einmal.";
  }
  if (status === 401) return "Nicht angemeldet — bitte neu einloggen.";
  const msg = e instanceof Error ? e.message : String(e ?? "");
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    return `Server nicht erreichbar (${msg})`;
  }
  return msg || "Import fehlgeschlagen";
}

/** Menschliche Größenangabe. */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Antwort des Servers auf die Zeilen der Auswahl abbilden.
 *
 * Der Vertrag benennt Abgewiesene nur über `name`. Jeder `rejected`-Eintrag
 * wird deshalb GENAU EINMAL verbraucht (gleicher Dateiname in zwei Ordnern
 * ist sonst mehrdeutig), die übrigen Dateien bekommen der Reihe nach die
 * zurückgegebenen Jobs. Bleibt am Ende ein `rejected`-Eintrag übrig, den
 * keine Zeile beansprucht, wird er separat angezeigt statt verschluckt.
 */
function applyUploadResult(
  rows: UploadEntry[],
  batch: UploadEntry[],
  res: FileImportResponse,
): { rows: UploadEntry[]; unmatched: FileImportRejection[] } {
  const pending = [...(res.rejected ?? [])];
  const jobs = [...(res.jobs ?? [])];
  const verdict = new Map<string, { state: UploadState; reason?: string }>();

  for (const item of batch) {
    const idx = pending.findIndex(
      (r) => r.name === item.file.name || r.name === item.relativePath,
    );
    if (idx >= 0) {
      const [hit] = pending.splice(idx, 1);
      verdict.set(item.key, { state: "rejected", reason: hit?.reason });
      continue;
    }
    const job = jobs.shift();
    verdict.set(
      item.key,
      job
        ? { state: "queued" }
        : { state: "failed", reason: "vom Server nicht bestätigt" },
    );
  }

  return {
    rows: rows.map((row) => {
      const v = verdict.get(row.key);
      return v ? { ...row, state: v.state, reason: v.reason } : row;
    }),
    unmatched: pending,
  };
}

/**
 * Flacht den Vault-Baum auf eine Liste reiner Ordner-Pfade ab. Vault-Root
 * ist immer mit dabei (leerer Pfad → der User darf in den Root schreiben,
 * auch wenn das selten erwünscht ist; wir filtern den hier raus, weil das
 * Import-Panel immer einen NAMENS-Ordner braucht — Captures kommen nicht
 * in den Root).
 */
function flattenFolders(nodes: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.type === "folder") {
        out.push(n.path);
        if (n.children.length > 0) walk(n.children);
      }
    }
  };
  walk(nodes);
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Import-Panel — Slide-over von rechts.
 *
 * Das aktive Gegenstück zum Web Share Target: URL rein, Typ wählen,
 * importieren. Darunter läuft dieselbe Pipe-Queue wie beim Teilen — das
 * Panel pollt sie, solange es offen ist, und zeigt jeden Job bis zur
 * fertigen Notiz.
 *
 * Engine ist Supadata (scrape / crawl / transcript). Ein neuer Import-Typ
 * = ein neuer Handler serverseitig + eine Zeile in TYPES hier.
 */

interface ImportPanelProps {
  open: boolean;
  onClose: () => void;
  /** wird mit der Notiz-id aufgerufen, wenn ein Import fertig ist */
  onImported: (noteId: string) => void;
}

const TYPES: {
  label: string;
  value: PipeType | "auto";
  icon: typeof Globe;
}[] = [
  { label: "Automatisch", value: "auto", icon: Sparkles },
  { label: "YouTube-Transkript", value: "youtube", icon: Youtube },
  { label: "Website — Seite", value: "url", icon: Globe },
  { label: "Website — ganze Site", value: "crawl", icon: Network },
];

const STATUS: Record<
  PipeJob["status"],
  { label: string; color: string; icon: typeof Check }
> = {
  queued: { label: "in Warteschlange", color: C.textFaint, icon: Loader2 },
  processing: { label: "verarbeitet…", color: C.gold, icon: Loader2 },
  done: { label: "fertig", color: C.ok, icon: Check },
  error: { label: "Fehler", color: C.err, icon: AlertTriangle },
};

export function ImportPanel({ open, onClose, onImported }: ImportPanelProps) {
  // Phase D Wave D1 — Slide-over goes full-width on phones; the type-grid
  // and folder browser inside the panel become unusable below ~340px wide.
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<Tab>("url");
  const [url, setUrl] = useState("");
  const [type, setType] = useState<PipeType | "auto">("auto");
  const [jobs, setJobs] = useState<PipeJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Ziel-Ordner — Default kommt aus den System-Settings (Wave 4a Agent G).
   * Der Server liefert bei fehlender Konfiguration "30_captures" zurück,
   * also kommt das Panel nie ohne Default-Wert ins UI; trotzdem halten
   * wir hier denselben Fallback bereit, falls der Fetch selbst scheitert.
   */
  const [targetFolder, setTargetFolder] = useState<string>(FALLBACK_FOLDER);
  const [folderOptions, setFolderOptions] = useState<string[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserFilter, setBrowserFilter] = useState("");
  const browseAnchorRef = useRef<HTMLDivElement | null>(null);

  /* ── Datei-/Ordner-Import ───────────────────────────────────────────────
   * Eigener Reiter, damit der URL-Import unangetastet bleibt: er behält
   * seine Maske, seine Typ-Auswahl und seinen Knopf. Geteilt werden nur
   * Ziel-Ordner und Job-Liste — beides gehört ohnehin beiden.
   * ─────────────────────────────────────────────────────────────────── */
  // Einmal beim ersten Rendern proben; die Fähigkeit ändert sich zur Laufzeit nicht.
  const [canPickDirectory] = useState(supportsDirectoryPicker);
  const [selected, setSelected] = useState<UploadEntry[]>([]);
  const [otherRejections, setOtherRejections] = useState<FileImportRejection[]>(
    [],
  );
  const [skippedHidden, setSkippedHidden] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  // Queue pollen, solange das Panel offen ist
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const tick = () => {
      api
        .pipes()
        .then((j) => alive && setJobs(j))
        .catch(() => {});
    };
    tick();
    const iv = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [open]);

  /**
   * Defaults + Ordnerliste laden, wenn das Panel öffnet. Beides bewusst
   * unabhängig — wenn `getImportDefaults` fehlschlägt (z.B. Settings-Agent
   * aus Wave 4a noch nicht deployed → 404), greift der lokale Fallback.
   * Wenn `tree()` fehlschlägt, bleibt der Browse-Button leer; manuelles
   * Tippen funktioniert weiter.
   */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .getImportDefaults()
      .then((d) => {
        if (!alive) return;
        const v = d.defaultImportFolder?.trim();
        if (v) setTargetFolder(v);
      })
      .catch(() => {
        /* fallback bleibt FALLBACK_FOLDER bzw. der letzte Wert */
      });
    api
      .tree()
      .then((nodes) => alive && setFolderOptions(flattenFolders(nodes)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // Browse-Popover schließt sich beim Klick außerhalb.
  useEffect(() => {
    if (!browserOpen) return;
    const onDown = (ev: MouseEvent) => {
      if (!browseAnchorRef.current) return;
      if (!browseAnchorRef.current.contains(ev.target as Node)) {
        setBrowserOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [browserOpen]);

  const filteredFolders = useMemo(() => {
    const f = browserFilter.trim().toLowerCase();
    if (!f) return folderOptions;
    return folderOptions.filter((p) => p.toLowerCase().includes(f));
  }, [browserFilter, folderOptions]);

  async function submit() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      const folder = targetFolder.trim() || FALLBACK_FOLDER;
      await api.importUrl({
        url: trimmed,
        type: type === "auto" ? undefined : type,
        targetFolder: folder,
      });
      setUrl("");
      // Job taucht beim nächsten Poll auf
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Auswahl übernehmen. Doppelt Gewähltes (zweimal dieselbe Datei gezogen)
   * fällt über die Signatur heraus, statt zweimal importiert zu werden.
   */
  function addFiles(files: SelectedFile[], skipped: number) {
    if (files.length === 0 && skipped === 0) return;
    setSelected((prev) => {
      const seen = new Set(
        prev.map((e) => `${e.relativePath}|${e.file.name}|${e.file.size}`),
      );
      const next = [...prev];
      for (const f of files) {
        const sig = `${f.relativePath}|${f.file.name}|${f.file.size}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        next.push({ ...f, key: `${next.length}:${sig}`, state: "ready" });
      }
      return next;
    });
    if (skipped > 0) setSkippedHidden((n) => n + skipped);
    setFileError(null);
  }

  function onPick(ev: ChangeEvent<HTMLInputElement>) {
    const list = ev.target.files;
    const picked = filesFromFileList(list);
    addFiles(picked, Math.max(0, (list?.length ?? 0) - picked.length));
    // Zurücksetzen, damit dieselbe Auswahl erneut ein change-Event auslöst.
    ev.target.value = "";
  }

  async function onDrop(ev: DragEvent) {
    ev.preventDefault();
    setDragOver(false);
    const { files, skippedHidden: skipped } = await collectDroppedFiles(
      ev.dataTransfer,
    );
    if (files.length > 0 || skipped > 0) {
      setTab("files");
      addFiles(files, skipped);
    }
  }

  const pendingCount = selected.filter(
    (e) => e.state === "ready" || e.state === "failed",
  ).length;
  /** Zeilen, über die der Server bereits geurteilt hat. */
  const settledCount = selected.filter(
    (e) => e.state === "queued" || e.state === "rejected",
  ).length;
  const totalBytes = selected.reduce((sum, e) => sum + (e.file.size ?? 0), 0);
  const rejectedRows = selected.filter((e) => e.state === "rejected");

  /**
   * Auswahl hochladen — in Häppchen, die der Server annimmt.
   *
   * Jede Anfrage aktualisiert nur ihre eigenen Zeilen, damit der Fortschritt
   * bei 500 Dateien sichtbar durchläuft statt am Ende auf einen Schlag zu
   * springen. Ein Fehlschlag betrifft genau sein Häppchen; die übrigen
   * laufen weiter.
   */
  async function uploadSelected() {
    if (uploading) return;
    const pending = selected.filter(
      (e) => e.state === "ready" || e.state === "failed",
    );
    if (pending.length === 0) return;

    setUploading(true);
    setFileError(null);
    const folder = targetFolder.trim() || FALLBACK_FOLDER;
    try {
      for (const batch of planUploadBatches(pending, UPLOAD_LIMITS)) {
        const keys = new Set(batch.map((b) => b.key));
        setSelected((prev) =>
          prev.map((e) =>
            keys.has(e.key)
              ? { ...e, state: "uploading", reason: undefined }
              : e,
          ),
        );
        try {
          const res = await api.importFiles(
            batch.map(({ file, relativePath }) => ({ file, relativePath })),
            folder,
          );
          setSelected((prev) => {
            const applied = applyUploadResult(prev, batch, res);
            if (applied.unmatched.length > 0) {
              setOtherRejections((old) => [...old, ...applied.unmatched]);
            }
            return applied.rows;
          });
        } catch (e) {
          const msg = readableUploadError(e);
          setSelected((prev) =>
            prev.map((x) =>
              keys.has(x.key) ? { ...x, state: "failed", reason: msg } : x,
            ),
          );
          setFileError(msg);
        }
      }
    } finally {
      setUploading(false);
    }
  }

  function clearSelection() {
    setSelected([]);
    setOtherRejections([]);
    setSkippedHidden(0);
    setFileError(null);
  }

  /* Ziel-Ordner-Feld — dasselbe Stück Oberfläche für URL- und Datei-Import.
   * Bewusst ein JSX-Wert und KEINE innere Komponente: eine im Render-Body
   * definierte Komponente bekäme bei jedem Tastendruck eine neue Identität
   * und würde neu montiert — das Feld verlöre den Fokus mitten im Tippen. */
  const folderField = (
    <>
          <label
            htmlFor="lokyy-import-target-folder"
            style={{
              fontSize: 11,
              color: C.textDim,
              display: "block",
              marginBottom: 6,
            }}
          >
            Ziel-Ordner
          </label>
          <div
            ref={browseAnchorRef}
            style={{
              position: "relative",
              display: "flex",
              gap: 6,
              marginBottom: 12,
            }}
          >
            <input
              id="lokyy-import-target-folder"
              value={targetFolder}
              placeholder={FALLBACK_FOLDER}
              onChange={(e) => setTargetFolder(e.target.value)}
              spellCheck={false}
              style={{
                flex: 1,
                minWidth: 0,
                boxSizing: "border-box",
                background: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 7,
                color: C.text,
                fontSize: 13,
                fontFamily: FONT.mono,
                padding: "8px 10px",
                outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => setBrowserOpen((v) => !v)}
              aria-label="Ordner aus dem Vault auswählen"
              aria-expanded={browserOpen}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "0 10px",
                borderRadius: 7,
                background: browserOpen ? C.accentDim : C.elevated,
                border: `1px solid ${browserOpen ? C.accent : C.border}`,
                color: browserOpen ? C.text : C.textDim,
                fontSize: 11.5,
                fontFamily: FONT.ui,
                cursor: "pointer",
              }}
            >
              <Folder size={13} style={{ color: C.gold }} />
              Browse
            </button>

            {browserOpen && (
              <div
                role="dialog"
                aria-label="Ordner-Auswahl"
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  right: 0,
                  zIndex: 50,
                  background: C.panel,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
                  maxHeight: 240,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <input
                  value={browserFilter}
                  onChange={(e) => setBrowserFilter(e.target.value)}
                  placeholder="Filter…"
                  autoFocus
                  style={{
                    background: C.bg,
                    border: "none",
                    borderBottom: `1px solid ${C.border}`,
                    color: C.text,
                    fontSize: 12,
                    fontFamily: FONT.mono,
                    padding: "7px 10px",
                    outline: "none",
                  }}
                />
                <div
                  style={{
                    overflowY: "auto",
                    flex: 1,
                    fontFamily: FONT.mono,
                    fontSize: 11.5,
                  }}
                >
                  {filteredFolders.length === 0 && (
                    <div
                      style={{
                        padding: "10px 12px",
                        color: C.textFaint,
                      }}
                    >
                      {folderOptions.length === 0
                        ? "Baum nicht geladen — manuell tippen"
                        : "keine Treffer"}
                    </div>
                  )}
                  {filteredFolders.map((p) => {
                    const active = p === targetFolder;
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => {
                          setTargetFolder(p);
                          setBrowserOpen(false);
                          setBrowserFilter("");
                        }}
                        style={{
                          width: "100%",
                          textAlign: "left",
                          background: active ? C.accentDim : "transparent",
                          color: active ? C.text : C.textDim,
                          border: "none",
                          borderBottom: `1px solid ${C.borderSoft}`,
                          padding: "7px 10px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <Folder size={12} style={{ color: C.gold }} />
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

    </>
  );

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.18s",
          zIndex: 40,
        }}
      />

      {/* Panel — Ziehen wird auf der ganzen Fläche angenommen: wer eine Datei
          knapp neben die Ablagefläche fallen lässt, soll nicht ins Leere
          greifen. Ein Drop wechselt auf den Datei-Reiter. */}
      <aside
        onDragOver={(ev) => {
          if (!Array.from(ev.dataTransfer?.types ?? []).includes("Files")) return;
          ev.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(ev) => {
          if (ev.currentTarget.contains(ev.relatedTarget as Node | null)) return;
          setDragOver(false);
        }}
        onDrop={onDrop}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? "100vw" : 360,
          maxWidth: "100vw",
          background: C.panel,
          borderLeft: isMobile ? "none" : `1px solid ${C.border}`,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.22s ease",
          zIndex: 41,
          display: "flex",
          flexDirection: "column",
          fontFamily: FONT.ui,
          color: C.text,
        }}
      >
        {/* Kopf */}
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px",
            height: 48,
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          <ArrowUpRight size={16} style={{ color: C.accent }} />
          <strong style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
            Import
          </strong>
          <button
            onClick={onClose}
            aria-label="Schließen"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "none",
              background: "transparent",
              color: C.textDim,
              cursor: "pointer",
              // Phase D Wave D1 — bump close affordance to 44×44 on mobile
              // so the thumb has a real target.
              width: isMobile ? 44 : 28,
              height: isMobile ? 44 : 28,
              padding: 0,
            }}
          >
            <X size={isMobile ? 22 : 16} />
          </button>
        </header>

        {/* Tab-Strip — URL/YouTube vs. Sprachaufnahme. Beide Streams landen
            in derselben Pipe-Queue (Anzeige unten), nur die Eingabe differiert. */}
        <div
          role="tablist"
          aria-label="Import-Quelle"
          style={{
            display: "flex",
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          {([
            { key: "url" as const, label: "Web / YouTube", icon: LinkIcon },
            { key: "files" as const, label: "Dateien", icon: Files },
            { key: "voice" as const, label: "Sprachaufnahme", icon: Mic },
          ]).map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 5,
                  padding: "10px 2px",
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  background: active ? C.elevated : "transparent",
                  border: "none",
                  borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
                  color: active ? C.text : C.textDim,
                  cursor: "pointer",
                  fontSize: 11.5,
                  fontFamily: FONT.ui,
                  fontWeight: active ? 600 : 500,
                }}
              >
                <Icon size={14} style={{ color: active ? C.accent : C.textFaint }} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Eingabe — Tab-abhängig */}
        {tab === "voice" ? (
          <div style={{ borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
            <VoiceRecorder
              active={open && tab === "voice"}
              onTranscribed={(noteId) => {
                onImported(noteId);
                onClose();
              }}
            />
          </div>
        ) : tab === "files" ? (
          <div
            style={{
              padding: 14,
              borderBottom: `1px solid ${C.border}`,
              flexShrink: 0,
              maxHeight: "55vh",
              overflowY: "auto",
            }}
          >
            {/* Ablagefläche. Das Ziehen selbst hängt am ganzen Panel (siehe
                <aside>), damit auch ein Fehlwurf neben die Fläche ankommt. */}
            <div
              aria-label="Dateien hierher ziehen"
              style={{
                border: `1px dashed ${dragOver ? C.accent : C.border}`,
                borderRadius: 8,
                background: dragOver ? C.accentDim : C.bg,
                padding: "16px 12px",
                textAlign: "center",
                marginBottom: 10,
                transition: "background 0.15s, border-color 0.15s",
              }}
            >
              <FileUp
                size={18}
                style={{ color: dragOver ? C.accent : C.textFaint }}
              />
              <div style={{ fontSize: 12, marginTop: 6 }}>
                Dateien oder Ordner hierher ziehen
              </div>
              <div
                style={{ fontSize: 10.5, color: C.textFaint, marginTop: 4 }}
              >
                Text, Markdown und PDF. Anderes weist der Server benannt ab.
              </div>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                  padding: isMobile ? "11px 8px" : "8px",
                  borderRadius: 7,
                  background: C.elevated,
                  border: `1px solid ${C.border}`,
                  color: C.text,
                  fontSize: 11.5,
                  fontFamily: FONT.ui,
                  cursor: "pointer",
                }}
              >
                <FileUp size={13} style={{ color: C.accent }} />
                Dateien auswählen
              </button>
              {/* Nur zeigen, wo der Browser es kann — ein toter Knopf ist
                  schlimmer als keiner (AC 12). */}
              {canPickDirectory && (
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    padding: isMobile ? "11px 8px" : "8px",
                    borderRadius: 7,
                    background: C.elevated,
                    border: `1px solid ${C.border}`,
                    color: C.text,
                    fontSize: 11.5,
                    fontFamily: FONT.ui,
                    cursor: "pointer",
                  }}
                >
                  <FolderUp size={13} style={{ color: C.gold }} />
                  Ordner auswählen
                </button>
              )}
            </div>

            {!canPickDirectory && (
              <div
                style={{
                  fontSize: 10.5,
                  color: C.textFaint,
                  fontFamily: FONT.ui,
                  marginBottom: 10,
                  lineHeight: 1.45,
                }}
              >
                Dieser Browser kann keine Ordner auswählen — mehrere Dateien
                gleichzeitig gehen trotzdem.
              </div>
            )}

            {/* Kein `accept`-Filter: was zulässig ist, entscheidet der Server
                und sagt es benannt. Ein enges accept würde Dateien verstecken,
                die der Server sehr wohl nähme. */}
            <input
              ref={fileInputRef}
              data-testid="lokyy-import-file-input"
              type="file"
              multiple
              onChange={onPick}
              style={{ display: "none" }}
            />
            {canPickDirectory && (
              <input
                ref={folderInputRef}
                data-testid="lokyy-import-folder-input"
                type="file"
                multiple
                onChange={onPick}
                style={{ display: "none" }}
                {...({
                  webkitdirectory: "",
                  directory: "",
                } as InputHTMLAttributes<HTMLInputElement>)}
              />
            )}

            {folderField}

            {skippedHidden > 0 && (
              <div
                style={{
                  fontSize: 10.5,
                  color: C.textFaint,
                  fontFamily: FONT.mono,
                  marginBottom: 8,
                }}
              >
                {skippedHidden} versteckte Datei
                {skippedHidden === 1 ? "" : "en"} übersprungen
              </div>
            )}

            {selected.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 6,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: C.textDim,
                      letterSpacing: 0.5,
                    }}
                  >
                    AUSWAHL
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color: C.textFaint,
                      fontFamily: FONT.mono,
                      flex: 1,
                    }}
                  >
                    {settledCount} von {selected.length} übertragen ·{" "}
                    {humanSize(totalBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={uploading}
                    aria-label="Auswahl leeren"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "transparent",
                      border: "none",
                      color: uploading ? C.textFaint : C.textDim,
                      fontSize: 10.5,
                      fontFamily: FONT.ui,
                      cursor: uploading ? "default" : "pointer",
                      padding: 0,
                    }}
                  >
                    <Trash2 size={12} />
                    leeren
                  </button>
                </div>

                {/* Nur die ersten Zeilen rendern — bei 500 Dateien wäre eine
                    vollständige Liste teuer und unlesbar zugleich. */}
                {selected.slice(0, VISIBLE_ROWS).map((entry) => {
                  const s = UPLOAD_LABEL[entry.state];
                  return (
                    <div
                      key={entry.key}
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 6,
                        padding: "4px 0",
                        borderBottom: `1px solid ${C.borderSoft}`,
                        fontFamily: FONT.mono,
                        fontSize: 11,
                      }}
                    >
                      <span
                        title={entry.relativePath || entry.file.name}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: C.textDim,
                        }}
                      >
                        {entry.relativePath || entry.file.name}
                      </span>
                      <span style={{ fontSize: 10, color: s.color }}>
                        {s.label}
                      </span>
                    </div>
                  );
                })}
                {selected.length > VISIBLE_ROWS && (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: C.textFaint,
                      fontFamily: FONT.mono,
                      paddingTop: 4,
                    }}
                  >
                    … und {selected.length - VISIBLE_ROWS} weitere
                  </div>
                )}
              </div>
            )}

            <button
              onClick={uploadSelected}
              disabled={uploading || pendingCount === 0}
              style={{
                width: "100%",
                padding: "9px 0",
                borderRadius: 7,
                border: "none",
                cursor: uploading || pendingCount === 0 ? "default" : "pointer",
                background:
                  uploading || pendingCount === 0 ? C.elevated : C.accent,
                color: uploading || pendingCount === 0 ? C.textFaint : "#1a1110",
                fontSize: 13,
                fontWeight: 600,
                fontFamily: FONT.ui,
              }}
            >
              {uploading
                ? "wird übertragen…"
                : pendingCount === 0
                  ? "Importieren"
                  : `${pendingCount} ${
                      pendingCount === 1 ? "Datei" : "Dateien"
                    } importieren`}
            </button>

            {fileError && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11.5,
                  color: C.err,
                  fontFamily: FONT.mono,
                }}
              >
                {fileError}
              </div>
            )}

            {/* Abgewiesenes — mit Namen und Grund, nie stillschweigend. */}
            {(rejectedRows.length > 0 || otherRejections.length > 0) && (
              <div style={{ marginTop: 10 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: C.err,
                    letterSpacing: 0.5,
                    marginBottom: 6,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <Ban size={12} />
                  ABGEWIESEN ({rejectedRows.length + otherRejections.length})
                </div>
                {[
                  ...rejectedRows.map((r) => ({
                    key: r.key,
                    name: r.relativePath || r.file.name,
                    reason: r.reason ?? "ohne Angabe",
                  })),
                  ...otherRejections.map((r, i) => ({
                    key: `extra-${i}-${r.name}`,
                    name: r.name,
                    reason: r.reason,
                  })),
                ].map((r) => (
                  <div
                    key={r.key}
                    style={{
                      fontFamily: FONT.mono,
                      fontSize: 11,
                      padding: "3px 0",
                      borderBottom: `1px solid ${C.borderSoft}`,
                    }}
                  >
                    <div
                      style={{
                        color: C.text,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {r.name}
                    </div>
                    <div style={{ color: C.err, fontSize: 10.5 }}>
                      {r.reason}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
        <div
          style={{
            padding: 14,
            borderBottom: `1px solid ${C.border}`,
            flexShrink: 0,
          }}
        >
          <label
            style={{
              fontSize: 11,
              color: C.textDim,
              display: "block",
              marginBottom: 6,
            }}
          >
            URL
          </label>
          <input
            value={url}
            placeholder="https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            style={{
              width: "100%",
              boxSizing: "border-box",
              background: C.bg,
              border: `1px solid ${C.border}`,
              borderRadius: 7,
              color: C.text,
              fontSize: 13,
              fontFamily: FONT.mono,
              padding: "8px 10px",
              outline: "none",
              marginBottom: 12,
            }}
          />

          {folderField}

          <label
            style={{
              fontSize: 11,
              color: C.textDim,
              display: "block",
              marginBottom: 6,
            }}
          >
            Typ
          </label>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 6,
              marginBottom: 12,
            }}
          >
            {TYPES.map((t) => {
              const active = type === t.value;
              const Icon = t.icon;
              return (
                <button
                  key={t.value}
                  onClick={() => setType(t.value)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "7px 8px",
                    borderRadius: 7,
                    cursor: "pointer",
                    fontSize: 11.5,
                    fontFamily: FONT.ui,
                    textAlign: "left",
                    background: active ? C.accentDim : C.elevated,
                    border: `1px solid ${active ? C.accent : C.border}`,
                    color: active ? C.text : C.textDim,
                  }}
                >
                  <Icon
                    size={13}
                    style={{ color: active ? C.accent : C.textFaint }}
                  />
                  {t.label}
                </button>
              );
            })}
          </div>

          <button
            onClick={submit}
            disabled={busy || !url.trim()}
            style={{
              width: "100%",
              padding: "9px 0",
              borderRadius: 7,
              border: "none",
              cursor: busy || !url.trim() ? "default" : "pointer",
              background: busy || !url.trim() ? C.elevated : C.accent,
              color: busy || !url.trim() ? C.textFaint : "#1a1110",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: FONT.ui,
            }}
          >
            {busy ? "wird gestartet…" : "Importieren"}
          </button>

          {error && (
            <div
              style={{
                marginTop: 8,
                fontSize: 11.5,
                color: C.err,
                fontFamily: FONT.mono,
              }}
            >
              {error}
            </div>
          )}
        </div>
        )}

        {/* Queue */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: C.textDim,
              letterSpacing: 0.5,
              marginBottom: 8,
            }}
          >
            QUEUE
          </div>
          {jobs.length === 0 && (
            <div
              style={{
                fontSize: 11.5,
                color: C.textFaint,
                fontFamily: FONT.mono,
              }}
            >
              noch keine importe
            </div>
          )}
          {jobs.map((job) => {
            const s = STATUS[job.status];
            const SIcon = s.icon;
            const spinning =
              job.status === "processing" || job.status === "queued";
            const source =
              job.payload.url ??
              job.payload.file?.name ??
              job.payload.text ??
              "—";
            return (
              <div
                key={job.id}
                style={{
                  background: C.elevated,
                  border: `1px solid ${C.border}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 9.5,
                      fontFamily: FONT.mono,
                      color: C.gold,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      padding: "1px 5px",
                    }}
                  >
                    {job.type}
                  </span>
                  <span style={{ flex: 1 }} />
                  <SIcon
                    size={12}
                    style={{ color: s.color }}
                    className={spinning ? "sw-spin" : undefined}
                  />
                  <span style={{ fontSize: 10.5, color: s.color }}>
                    {s.label}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: C.textDim,
                    fontFamily: FONT.mono,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {source}
                </div>
                {job.status === "done" && job.resultNoteId && (
                  <button
                    onClick={() => {
                      onImported(job.resultNoteId!);
                      onClose();
                    }}
                    style={{
                      marginTop: 6,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "transparent",
                      border: "none",
                      color: C.accent,
                      fontSize: 11.5,
                      fontFamily: FONT.ui,
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    Notiz öffnen <ArrowUpRight size={12} />
                  </button>
                )}
                {job.status === "error" && job.error && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 10.5,
                      color: C.err,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {job.error}
                  </div>
                )}
                {/* Hinweis zu einem GELUNGENEN Job — z.B. ein PDF ohne
                    Textebene (Scan): die Notiz liegt im Vault, ist aber leer.
                    Ohne diese Zeile stünde der Nutzer vor einer leeren Datei
                    und wüsste nicht, warum. */}
                {job.notice && (
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 10.5,
                      color: C.gold,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {job.notice}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
