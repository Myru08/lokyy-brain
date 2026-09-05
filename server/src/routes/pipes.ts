import { Hono } from "hono";
import type {
  FileImportRejection,
  ImportRequest,
  PipeJob,
  SharePayload,
} from "@lokyy/shared";
import {
  classifyImportFile,
  enqueue,
  listJobs,
  resolveInsideVault,
  sanitizeFileName,
  sanitizeRelativePath,
  unsupportedReason,
  coreConfig,
} from "@lokyy/core";
import { config } from "../config.js";
import { resolveDefaultImportFolder } from "../settings/importDefaults.js";

/** /api/pipes — Web Share Target, aktiver Import + Queue-Status. */
export const pipesRoutes = new Hono();

// GET /api/pipes -> PipeJob[]
pipesRoutes.get("/", (c) => c.json(listJobs()));

/**
 * `targetFolder` darf vom Client kommen — aber er muss SPEC-konform sein:
 * relativer Pfad, keine `..`-Segmente, kein Backslash, kein führender
 * Slash. Sonst landet ein Pipe-Result außerhalb des Vaults.
 */
function sanitizeTargetFolder(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return undefined;
  if (trimmed.includes("\\") || trimmed.split("/").some((seg) => seg === ".." || seg === "."))
    return undefined;
  return trimmed;
}

/**
 * POST /api/pipes/import — bewusst angestoßener Import aus dem Import-Panel.
 * Im Gegensatz zu /share kann der Typ hier explizit mitgegeben werden.
 *
 * `targetFolder` überschreibt für diesen Import den `default_import_folder`
 * aus den System-Settings. Fehlt das Feld, lädt der Server den Default
 * frisch aus `system_config` und legt ihn dem Pipe-Job bei, damit die
 * Handler später nur noch `payload.targetFolder` lesen müssen.
 */
pipesRoutes.post("/import", async (c) => {
  const body = await c.req.json<ImportRequest>();
  if (!body.url) return c.json({ error: "url erforderlich" }, 400);

  const targetFolder =
    sanitizeTargetFolder(body.targetFolder) ??
    (await resolveDefaultImportFolder());

  const payload: SharePayload = { url: body.url, targetFolder };
  const job = enqueue(payload, body.type);
  return c.json(job, 202);
});

/**
 * POST /api/pipes/share — Ziel des Web Share Target der PWA.
 *
 * Akzeptiert sowohl JSON als auch multipart/form-data (so liefert der
 * Browser ein Share mit Datei). Bei Datei wird sie base64-kodiert
 * weitergereicht.
 */
pipesRoutes.post("/share", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let payload: SharePayload;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    payload = {
      title: (form.get("title") as string) ?? undefined,
      text: (form.get("text") as string) ?? undefined,
      url: (form.get("url") as string) ?? undefined,
    };
    if (file && file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      payload.file = {
        name: file.name,
        mime: file.type,
        dataBase64: buf.toString("base64"),
      };
    }
  } else {
    payload = await c.req.json<SharePayload>();
  }

  // Web-Share-Target schickt selten `targetFolder` mit — Default aus
  // den System-Settings dazulegen, damit Handler einen einheitlichen
  // Vertrag haben.
  if (!sanitizeTargetFolder(payload.targetFolder)) {
    payload.targetFolder = await resolveDefaultImportFolder();
  } else {
    payload.targetFolder = sanitizeTargetFolder(payload.targetFolder);
  }

  const job = enqueue(payload);
  return c.json(job, 202);
});

/**
 * POST /api/pipes/files — Datei- und Ordner-Import (Issue #63).
 *
 * multipart/form-data:
 *   file          n-mal   die Dateien
 *   relativePath  n-mal   parallel zu `file`, gleiche Reihenfolge. Beim
 *                         Ordner-Import `webkitRelativePath`, sonst leer.
 *   targetFolder  1-mal   optional; fehlt er, gilt der Settings-Default.
 *
 * 202 { jobs, rejected } — ein Job je akzeptierter Datei.
 * 400 { error, message, jobs: [], rejected } — keine verwertbare Datei dabei.
 *     Die `rejected`-Liste steht auch hier drin: wenn ALLE Dateien
 *     abgewiesen wurden, sind ihre Gruende genau das, was der Nutzer sehen
 *     muss. Ein nacktes `{ error }` wuerde sie verschlucken.
 * 413 { error, message } — die Anfrage als Ganzes ist zu gross.
 *
 * Ein Job **je Datei**, damit der Fortschritt in der bestehenden Job-Liste
 * sichtbar bleibt.
 */
pipesRoutes.post("/files", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json(
      {
        error: "bad-content-type",
        message: "multipart/form-data erforderlich",
      },
      400,
    );
  }

  // Groessen-Vorpruefung VOR dem Parsen. `c.req.formData()` puffert die
  // komplette Anfrage im Speicher — waere die Pruefung erst danach, haette
  // der Server das Speicherproblem schon, das sie verhindern soll.
  // Content-Length schickt jeder Browser bei einem FormData-POST mit; fehlt
  // es (chunked), greift weiter unten die Summe der Einzeldateien.
  const declaredLength = Number(c.req.header("content-length") ?? "");
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > config.importMaxRequestBytes
  ) {
    return c.json(
      {
        error: "request-too-large",
        message: `Anfrage zu gross (${declaredLength} Bytes). Obergrenze: ${config.importMaxRequestBytes} Bytes (IMPORT_MAX_REQUEST_BYTES).`,
      },
      413,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    return c.json(
      {
        error: "multipart-parse-failed",
        message: err instanceof Error ? err.message : "multipart parse failed",
      },
      400,
    );
  }

  const files = form.getAll("file").filter((f): f is File => f instanceof File);
  const paths = form.getAll("relativePath").map((p) => (typeof p === "string" ? p : ""));

  const baseFolder =
    sanitizeTargetFolder(form.get("targetFolder")) ??
    (await resolveDefaultImportFolder());

  const jobs: PipeJob[] = [];
  const rejected: FileImportRejection[] = [];
  let acceptedBytes = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const relativePath = paths[i]?.trim() ?? "";
    const label = relativePath || file.name || `Datei ${i + 1}`;

    // 1. Pfad: entweder der Ordner-Pfad vom Client oder nur der Dateiname.
    //    `..`, absolute Pfade und Laufwerksbuchstaben werden benannt
    //    abgewiesen statt heimlich zurechtgebogen (siehe importPaths.ts).
    const pathCheck = relativePath
      ? sanitizeRelativePath(relativePath)
      : sanitizeFileName(file.name);
    if (!pathCheck.ok) {
      rejected.push({ name: label, reason: pathCheck.reason });
      continue;
    }
    const subDir = "dir" in pathCheck ? pathCheck.dir : "";
    const targetFolder = subDir ? `${baseFolder}/${subDir}` : baseFolder;

    // 2. Letzte Verteidigungslinie: der zusammengesetzte Ordner muss
    //    aufgeloest INNERHALB des Vaults liegen.
    if (!resolveInsideVault(coreConfig().vaultDir, targetFolder)) {
      rejected.push({
        name: label,
        reason: "Zielpfad liegt ausserhalb des Vaults",
      });
      continue;
    }

    // 3. Typ: Endung UND MIME (Browser liefern fuer `.md` haeufig
    //    `application/octet-stream`).
    const kind = classifyImportFile(pathCheck.name, file.type);
    if (!kind) {
      rejected.push({
        name: label,
        reason: unsupportedReason(pathCheck.name, file.type),
      });
      continue;
    }

    // 4. Groesse: pro Datei und in Summe.
    if (file.size === 0) {
      rejected.push({ name: label, reason: "Datei ist leer" });
      continue;
    }
    if (file.size > config.importMaxFileBytes) {
      rejected.push({
        name: label,
        reason: `Datei zu gross (${file.size} Bytes). Obergrenze pro Datei: ${config.importMaxFileBytes} Bytes.`,
      });
      continue;
    }
    if (acceptedBytes + file.size > config.importMaxRequestBytes) {
      rejected.push({
        name: label,
        reason: `Obergrenze der Anfrage (${config.importMaxRequestBytes} Bytes) erreicht — bitte in kleineren Portionen importieren.`,
      });
      continue;
    }

    let dataBase64: string;
    try {
      dataBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    } catch (err) {
      rejected.push({
        name: label,
        reason: `Datei nicht lesbar: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    acceptedBytes += file.size;

    const payload: SharePayload = {
      file: {
        name: pathCheck.name,
        mime: file.type || "",
        dataBase64,
      },
      targetFolder,
      relativePath: subDir ? `${subDir}/${pathCheck.name}` : pathCheck.name,
    };
    jobs.push(enqueue(payload, kind));
  }

  if (jobs.length === 0) {
    return c.json(
      {
        error: files.length === 0 ? "no-files" : "no-usable-files",
        message:
          files.length === 0
            ? "Keine Datei im Feld 'file' gefunden."
            : "Keine der uebermittelten Dateien konnte importiert werden.",
        jobs,
        rejected,
      },
      400,
    );
  }

  return c.json({ jobs, rejected }, 202);
});
