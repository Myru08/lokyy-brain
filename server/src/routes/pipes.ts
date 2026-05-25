import { Hono } from "hono";
import type { ImportRequest, SharePayload } from "@lokyy/shared";
import { enqueue, listJobs } from "@lokyy/core";
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
