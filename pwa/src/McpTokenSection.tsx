import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { C, FONT } from "./theme.js";
import { api } from "./api.js";
import type { OwnMcpTokenList, OwnMcpTokenMeta } from "./api.js";

/**
 * MCP-Token-Verwaltung für den EIGENEN Vault (Story 7.10).
 *
 * Ersetzt den alten Weg „setze LOKYY_MCP_TOKEN in der Env und starte neu".
 * Zwei Eigenschaften prägen die gesamte UI:
 *
 *  1. **Der Klartext ist nicht wiederherstellbar.** In der DB liegt nur der
 *     SHA-256-Hash. Deshalb gibt es genau eine Anzeige direkt nach dem
 *     Erzeugen — und bewusst KEINEN „Token erneut anzeigen"-Knopf, den es
 *     technisch nicht geben kann. Verloren = widerrufen + neu erzeugen.
 *  2. **Kein Neustart nötig.** `lookupMcpToken` läuft pro Request; ein neuer
 *     Token gilt sofort, ein widerrufener ist sofort tot. Genau das ist der
 *     Gewinn gegenüber der Umgebungsvariable, also sagt die UI es explizit.
 */

const btn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  background: C.elevated,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  fontFamily: FONT.ui,
  fontSize: 13,
  cursor: "pointer",
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
}

export function McpTokenSection({
  endpoint,
  onFreshToken,
}: {
  /** Öffentliche MCP-URL für den fertigen Verbindungsblock. */
  endpoint?: string;
  /**
   * Meldet den frisch erzeugten Klartext nach oben, damit die
   * Konfigurations-Snippets ihren Platzhalter ersetzen können. `null` beim
   * Ausblenden.
   */
  onFreshToken?: (token: string | null) => void;
}) {
  const [data, setData] = useState<OwnMcpTokenList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.listOwnMcpTokens());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Laden fehlgeschlagen");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function copy(label: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  async function generate() {
    setBusy(true);
    setActionError(null);
    try {
      const created = await api.createOwnMcpToken({ label: "MCP-Client" });
      setFresh(created.token);
      onFreshToken?.(created.token);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Erzeugen fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      await api.revokeOwnMcpToken(id);
      setConfirmRevoke(null);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Widerrufen fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  function dismissFresh() {
    setFresh(null);
    onFreshToken?.(null);
  }

  const live = (data?.tokens ?? []).filter((t) => !t.revokedAt);
  const connectionBlock = fresh
    ? [
        endpoint ? `URL: ${endpoint}` : null,
        `Authorization: Bearer ${fresh}`,
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  return (
    <div
      style={{
        marginBottom: 18,
        padding: 14,
        background: C.elevated,
        border: `2px solid ${data?.envToken.shared ? C.err : C.border}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <strong
          style={{ fontFamily: FONT.serif, fontSize: 15, color: C.text }}
        >
          🔑 MCP-Token
        </strong>
        <button
          onClick={() => void generate()}
          disabled={busy}
          style={{ ...btn, opacity: busy ? 0.6 : 1 }}
        >
          {busy ? <Loader2 size={12} /> : <Plus size={12} />} Token erzeugen
        </button>
      </div>

      <p style={{ color: C.textDim, fontSize: 12, margin: "0 0 10px 0" }}>
        Dein Bearer-Token für die MCP-Anbindung. Er wird{" "}
        <strong>bei jedem Request neu geprüft</strong> — ein erzeugter Token
        gilt sofort und ein widerrufener ist sofort tot,{" "}
        <strong>ohne Neustart</strong> des Stacks.
      </p>

      {loadError && (
        <div style={{ color: C.err, fontSize: 12, marginBottom: 10 }}>
          <AlertTriangle size={12} /> Token konnten nicht geladen werden:{" "}
          {loadError}
        </div>
      )}
      {actionError && (
        <div style={{ color: C.err, fontSize: 12, marginBottom: 10 }}>
          <AlertTriangle size={12} /> {actionError}
        </div>
      )}

      {/* AC#7 — der geteilte Default aus dem öffentlichen Repo. Wird weiterhin
          akzeptiert (sonst brechen laufende Installationen), aber deutlich als
          unsicher markiert, mit dem Erzeugen-Knopf direkt daneben. */}
      {data?.envToken.shared && (
        <div
          style={{
            padding: 10,
            marginBottom: 10,
            border: `1px solid ${C.err}`,
            borderRadius: 6,
            color: C.err,
            fontSize: 12,
          }}
        >
          <strong>
            <AlertTriangle size={12} /> Unsicher: diese Installation benutzt
            noch den öffentlich bekannten Standard-Token
          </strong>
          <br />
          <code style={{ fontFamily: FONT.mono }}>
            LOKYY_MCP_TOKEN=local_dev_change_me…
          </code>{" "}
          steht so im öffentlichen Repo — jede Installation, die ihn behält,
          teilt sich dasselbe Passwort. Erzeuge oben einen eigenen Token und
          entferne die Variable anschließend aus deinem Deployment.
        </div>
      )}
      {data?.envToken.configured && !data.envToken.shared && (
        <p style={{ color: C.textFaint, fontSize: 11, margin: "0 0 10px 0" }}>
          Zusätzlich aktiv: der Token aus der Umgebungsvariablen{" "}
          <code style={{ fontFamily: FONT.mono }}>LOKYY_MCP_TOKEN</code>. Er
          bleibt gültig; Änderungen daran brauchen weiterhin einen Neustart.
        </p>
      )}

      {/* Einmalanzeige des Klartexts (AC#3). */}
      {fresh && (
        <div
          style={{
            padding: 12,
            marginBottom: 12,
            border: `2px solid ${C.gold}`,
            borderRadius: 6,
            background: C.panel,
          }}
        >
          <p style={{ color: C.gold, fontSize: 12, margin: "0 0 8px 0" }}>
            <strong>Jetzt kopieren — du siehst ihn nur dieses eine Mal.</strong>{" "}
            Gespeichert wird nur ein Hash; wiederherstellen ist unmöglich.
            Bestehende Client-Konfigurationen musst du mit diesem Token{" "}
            <strong>neu hinterlegen</strong>.
          </p>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: 8,
            }}
          >
            <code
              style={{
                flex: "1 1 auto",
                minWidth: 0,
                padding: "8px 12px",
                background: C.elevated,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontFamily: FONT.mono,
                fontSize: 13,
                color: C.gold,
                wordBreak: "break-all",
              }}
            >
              {fresh}
            </code>
            <button onClick={() => copy("fresh-token", fresh)} style={btn}>
              <Copy size={12} /> {copied === "fresh-token" ? "kopiert" : "Copy"}
            </button>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
              marginBottom: 4,
            }}
          >
            <span
              style={{ fontSize: 11, color: C.textDim, fontFamily: FONT.mono }}
            >
              Verbindung
            </span>
            <button
              onClick={() => copy("connection", connectionBlock)}
              style={{ ...btn, padding: "4px 8px", fontSize: 11 }}
            >
              <Copy size={12} />{" "}
              {copied === "connection" ? "kopiert" : "kopieren"}
            </button>
          </div>
          <pre
            style={{
              padding: 12,
              margin: 0,
              background: C.elevated,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              fontFamily: FONT.mono,
              fontSize: 12,
              color: C.text,
              overflow: "auto",
            }}
          >
            {connectionBlock}
          </pre>
          <button
            onClick={dismissFresh}
            style={{ ...btn, marginTop: 10 }}
          >
            <X size={12} /> Verstanden, ausblenden
          </button>
        </div>
      )}

      {/* Bestandsliste — ausschließlich Metadaten (AC#2). */}
      {data && data.tokens.length === 0 && !loadError && (
        <p style={{ color: C.textDim, fontSize: 12, margin: 0 }}>
          Noch kein eigener Token vorhanden. Erzeuge einen, um deinen Vault an
          eine KI anzubinden.
        </p>
      )}

      {data && data.tokens.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {data.tokens.map((t: OwnMcpTokenMeta) => {
            const revoked = Boolean(t.revokedAt);
            return (
              <div
                key={t.id}
                style={{
                  padding: 10,
                  border: `1px solid ${C.border}`,
                  borderRadius: 6,
                  background: C.panel,
                  opacity: revoked ? 0.55 : 1,
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: C.text,
                      fontSize: 13,
                      textDecoration: revoked ? "line-through" : "none",
                    }}
                  >
                    {t.label ?? "MCP-Client"}
                  </div>
                  <div
                    style={{
                      color: C.textFaint,
                      fontSize: 11,
                      fontFamily: FONT.mono,
                    }}
                  >
                    {t.agentId} · {t.role} · angelegt {fmtDate(t.createdAt)} ·
                    zuletzt benutzt {fmtDate(t.lastUsedAt)}
                    {revoked && ` · widerrufen ${fmtDate(t.revokedAt)}`}
                  </div>
                </div>
                {!revoked &&
                  (confirmRevoke === t.id ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        onClick={() => void revoke(t.id)}
                        disabled={busy}
                        style={{ ...btn, color: C.err, borderColor: C.err }}
                      >
                        Endgültig widerrufen
                      </button>
                      <button
                        onClick={() => setConfirmRevoke(null)}
                        style={btn}
                      >
                        Abbrechen
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmRevoke(t.id)}
                      style={{ ...btn, padding: "4px 10px", fontSize: 12 }}
                    >
                      <X size={12} /> widerrufen
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {data && live.length === 0 && data.tokens.length > 0 && (
        <p style={{ color: C.textDim, fontSize: 11, margin: "8px 0 0 0" }}>
          Kein gültiger Token mehr — erzeuge einen neuen, sonst kommt kein
          Client mehr an den Vault.
        </p>
      )}

      <button
        onClick={() => void load()}
        style={{ ...btn, marginTop: 10, padding: "4px 10px", fontSize: 11 }}
      >
        <RefreshCw size={11} /> aktualisieren
      </button>
    </div>
  );
}
