import { useEffect, useRef, useState } from "react";
import type { SharePayload } from "@lokyy/shared";
import { api, ApiError } from "../api.js";
import { C, FONT } from "../theme.js";

/*
 * Story 11.8 — Empfangs-/Quittungs-Screen für das Web-Share-Target.
 *
 * Flow (Addendum §6):
 *   1. Browser POSTet den Share an `/share` (multipart) → der Service Worker
 *      (`public/share-sw.js`) parkt die FormData und redirectet auf GET
 *      `/share?from=share-target`.
 *   2. main.tsx rendert bei pathname `/share` diese Komponente statt der App.
 *   3. Wir lesen die geparkte Payload aus (`/__share_target_payload`), fallen
 *      bei Bedarf auf GET-Query-Params zurück (Browser ohne aktiven SW), und
 *      posten via `api.share()` an das bestehende `POST /api/pipes/share`.
 *   4. Wir zeigen IMMER eine Quittung „In Inbox aufgenommen — {title|url}" —
 *      NIEMALS die rohe JSON-Antwort (das war der YouTube-JSON-Bug).
 *
 * Keine Verarbeitungslogik hier — die Pipe-Queue (Epic 6) erledigt den Rest.
 */

const SHARE_PAYLOAD_URL = "/__share_target_payload";

type Phase =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "done"; label: string }
  | { kind: "error"; message: string };

/** Was wir tatsächlich geteilt bekommen haben — entweder aus SW-Cache oder Query. */
interface ParkedMeta {
  title?: string;
  text?: string;
  url?: string;
  hasFile?: boolean;
  fileName?: string;
  fileType?: string;
}

/** Liest die vom Service Worker geparkte Share-Payload. Wirft nie. */
async function readParkedPayload(): Promise<ParkedMeta | null> {
  try {
    const res = await fetch(SHARE_PAYLOAD_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as ParkedMeta & { empty?: boolean };
    if (data.empty) return null;
    return data;
  } catch {
    return null;
  }
}

/** Liest die geparkte Datei (falls vorhanden) als base64 für die SharePayload. */
async function readParkedFile(
  meta: ParkedMeta,
): Promise<SharePayload["file"] | undefined> {
  if (!meta.hasFile) return undefined;
  try {
    const res = await fetch(SHARE_PAYLOAD_URL + "/file", { cache: "no-store" });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    const dataBase64 = await blobToBase64(blob);
    return {
      name: meta.fileName || "shared-file",
      mime: meta.fileType || blob.type || "application/octet-stream",
      dataBase64,
    };
  } catch {
    return undefined;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result ?? "");
      // result ist `data:<mime>;base64,<payload>` — nur den Payload-Teil.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Fallback: title/text/url aus der GET-Query (Browser ohne aktiven SW). */
function readQueryPayload(): ParkedMeta | null {
  if (typeof window === "undefined") return null;
  const q = new URLSearchParams(window.location.search);
  const title = q.get("title") ?? undefined;
  const text = q.get("text") ?? undefined;
  const url = q.get("url") ?? undefined;
  if (!title && !text && !url) return null;
  return { title, text, url };
}

/** Baut die menschenlesbare Quittungs-Bezeichnung — title bevorzugt, dann url. */
function receiptLabel(meta: ParkedMeta): string {
  if (meta.title && meta.title.trim()) return meta.title.trim();
  if (meta.url && meta.url.trim()) return meta.url.trim();
  if (meta.fileName && meta.fileName.trim()) return meta.fileName.trim();
  if (meta.text && meta.text.trim()) {
    const t = meta.text.trim();
    return t.length > 80 ? t.slice(0, 77) + "…" : t;
  }
  return "geteilter Inhalt";
}

export function ShareTarget() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  // StrictMode rendert Effekte doppelt — wir senden den Share nur einmal.
  const sentRef = useRef(false);

  useEffect(() => {
    if (sentRef.current) return;
    sentRef.current = true;

    void (async () => {
      const meta = (await readParkedPayload()) ?? readQueryPayload();
      if (!meta) {
        setPhase({ kind: "empty" });
        return;
      }

      const file = await readParkedFile(meta);
      const payload: SharePayload = {
        title: meta.title || undefined,
        text: meta.text || undefined,
        url: meta.url || undefined,
        ...(file ? { file } : {}),
      };

      try {
        await api.share(payload);
        setPhase({ kind: "done", label: receiptLabel(meta) });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : "Teilen fehlgeschlagen — bitte erneut versuchen.";
        setPhase({ kind: "error", message });
      }
    })();
  }, []);

  return (
    <div style={styles.shell}>
      <div style={styles.card}>
        {phase.kind === "loading" && (
          <>
            <h1 style={styles.h1}>Wird geteilt …</h1>
            <p style={styles.p}>Inhalt wird an die Inbox übergeben.</p>
          </>
        )}

        {phase.kind === "done" && (
          <>
            <div style={styles.badge}>✓</div>
            <h1 style={styles.h1}>In Inbox aufgenommen</h1>
            <p style={styles.label}>{phase.label}</p>
            <a href="/?import=1" style={styles.primaryLink}>
              Inbox öffnen
            </a>
          </>
        )}

        {phase.kind === "empty" && (
          <>
            <h1 style={styles.h1}>Nichts zum Teilen</h1>
            <p style={styles.p}>
              Es wurde kein geteilter Inhalt empfangen. Teile aus einer anderen
              App heraus über „Teilen → Lokyy".
            </p>
            <a href="/" style={styles.secondaryLink}>
              Zur App
            </a>
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div style={{ ...styles.badge, background: C.err }}>!</div>
            <h1 style={styles.h1}>Teilen fehlgeschlagen</h1>
            <p style={styles.p}>{phase.message}</p>
            <a href="/" style={styles.secondaryLink}>
              Zur App
            </a>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: "100dvh",
    background: C.bg,
    color: C.text,
    fontFamily: FONT.ui,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    boxSizing: "border-box",
  },
  card: {
    background: C.panel,
    border: `1px solid ${C.border}`,
    borderRadius: 16,
    padding: "32px 28px",
    maxWidth: 420,
    width: "100%",
    textAlign: "center",
    boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    background: C.accent,
    color: C.bg,
    fontSize: 30,
    fontWeight: 700,
    lineHeight: "56px",
    margin: "0 auto 16px",
  },
  h1: {
    fontSize: 20,
    fontWeight: 600,
    margin: "0 0 8px",
    color: C.text,
  },
  p: {
    fontSize: 14,
    lineHeight: 1.5,
    color: C.textDim,
    margin: "0 0 20px",
  },
  label: {
    fontSize: 15,
    fontWeight: 500,
    color: C.text,
    wordBreak: "break-word",
    margin: "0 0 24px",
  },
  primaryLink: {
    display: "inline-block",
    background: C.accent,
    color: C.bg,
    textDecoration: "none",
    fontWeight: 600,
    fontSize: 14,
    padding: "10px 22px",
    borderRadius: 10,
  },
  secondaryLink: {
    display: "inline-block",
    background: "transparent",
    color: C.accent,
    textDecoration: "none",
    fontWeight: 500,
    fontSize: 14,
    padding: "10px 22px",
    borderRadius: 10,
    border: `1px solid ${C.border}`,
  },
};
