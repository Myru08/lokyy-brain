import { useEffect, useState } from "react";
import { api, ApiError, type TenantVault, type CreateTenantResult } from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * Mandanten / Kunden tab (LBMT-1.5).
 *
 * Operator surface for the multi-tenant feature: list provisioned vaults +
 * their MCP tokens, provision a new customer (shared) vault, copy the one-time
 * token + connector URL, and revoke tokens. Talks to `/api/tenants`.
 */

const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const box: React.CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: 16,
};
const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: C.textDim,
  marginBottom: 4,
};
const input: React.CSSProperties = {
  width: "100%",
  background: C.bg,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  color: C.text,
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: FONT.ui,
  boxSizing: "border-box",
};
const btn = (primary = false): React.CSSProperties => ({
  background: primary ? C.accent : "transparent",
  color: primary ? "#000" : C.text,
  border: `1px solid ${primary ? C.accent : C.border}`,
  borderRadius: 6,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: FONT.ui,
});
const mono: React.CSSProperties = {
  fontFamily: FONT.mono,
  fontSize: 12,
  color: C.gold,
  wordBreak: "break-all",
};

export function TenantsTab() {
  const [tenants, setTenants] = useState<TenantVault[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [agentId, setAgentId] = useState("");
  const [role, setRole] = useState<"read" | "write">("write");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateTenantResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const connector = `${window.location.origin}/mcp`;

  async function load() {
    try {
      const r = await api.listTenants();
      setTenants(r.tenants);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Laden fehlgeschlagen");
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  }

  async function create() {
    setErr(null);
    const finalSlug = slug.trim() || slugify(name);
    const finalAgent = agentId.trim() || `kunde-${finalSlug}`;
    if (!name.trim() || !finalSlug) {
      setErr("Name (und damit Slug) ist erforderlich.");
      return;
    }
    setCreating(true);
    try {
      const res = await api.createTenant({
        name: name.trim(),
        slug: finalSlug,
        agentId: finalAgent,
        kind: "shared",
        role,
      });
      setCreated(res);
      setName("");
      setSlug("");
      setAgentId("");
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Anlegen fehlgeschlagen");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(tokenId: string) {
    if (!window.confirm("Diesen Token wirklich widerrufen? Der Kunde verliert sofort den Zugriff.")) {
      return;
    }
    try {
      await api.revokeTenantToken(tokenId);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Widerrufen fehlgeschlagen");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760 }}>
      <div>
        <h2 style={{ fontFamily: FONT.serif, color: C.text, margin: "0 0 4px" }}>
          Kunden / Mandanten
        </h2>
        <p style={{ color: C.textDim, fontSize: 13, margin: 0 }}>
          Geteilte Vaults pro Kunde. Jeder Kunde bekommt einen eigenen MCP-Token
          und sieht nur seine freigegebenen Ordner (<code style={{ color: C.gold }}>Freigabe/</code>,{" "}
          <code style={{ color: C.gold }}>RAW/kunde/</code>) — der Rest bleibt unsichtbar.
        </p>
      </div>

      {err && (
        <div style={{ ...box, borderColor: C.err, color: C.err, fontSize: 13 }}>{err}</div>
      )}

      {/* Anlegen */}
      <div style={box}>
        <h3 style={{ color: C.text, margin: "0 0 12px", fontSize: 15 }}>Kunde anlegen</h3>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label style={label}>Name</label>
            <input
              style={input}
              value={name}
              placeholder="z. B. Acme GmbH"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label style={label}>Slug (optional)</label>
            <input
              style={input}
              value={slug}
              placeholder={name ? slugify(name) : "acme-gmbh"}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          <div>
            <label style={label}>Agent-ID (optional)</label>
            <input
              style={input}
              value={agentId}
              placeholder={`kunde-${slug.trim() || slugify(name) || "…"}`}
              onChange={(e) => setAgentId(e.target.value)}
            />
          </div>
          <div>
            <label style={label}>Rolle</label>
            <select
              style={input}
              value={role}
              onChange={(e) => setRole(e.target.value as "read" | "write")}
            >
              <option value="write">Lesen + Schreiben</option>
              <option value="read">Nur Lesen</option>
            </select>
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <button style={btn(true)} disabled={creating} onClick={() => void create()}>
            {creating ? "Lege an…" : "Kunde anlegen"}
          </button>
        </div>
      </div>

      {/* Einmalig: neuer Token */}
      {created && (
        <div style={{ ...box, borderColor: C.accent, background: C.accentSoft }}>
          <h3 style={{ color: C.accent, margin: "0 0 8px", fontSize: 15 }}>
            ✓ {created.slug} angelegt — Token jetzt kopieren!
          </h3>
          <p style={{ color: C.textDim, fontSize: 12, margin: "0 0 12px" }}>
            Dieser Token wird <b>nur einmal</b> angezeigt. Gib Connector-URL + Token an den Kunden.
          </p>
          <label style={label}>Connector-URL</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={{ ...mono, flex: 1 }}>{connector}</span>
            <button style={btn()} onClick={() => void copy(connector, "url")}>
              {copied === "url" ? "kopiert" : "kopieren"}
            </button>
          </div>
          <label style={label}>Bearer-Token</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ ...mono, flex: 1 }}>{created.token}</span>
            <button style={btn(true)} onClick={() => void copy(created.token, "tok")}>
              {copied === "tok" ? "kopiert" : "kopieren"}
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <button style={btn()} onClick={() => setCreated(null)}>
              Schließen
            </button>
          </div>
        </div>
      )}

      {/* Liste */}
      <div>
        <h3 style={{ color: C.text, margin: "0 0 10px", fontSize: 15 }}>
          Vaults {tenants ? `(${tenants.length})` : ""}
        </h3>
        {tenants === null ? (
          <p style={{ color: C.textDim, fontSize: 13 }}>Lädt…</p>
        ) : tenants.length === 0 ? (
          <p style={{ color: C.textDim, fontSize: 13 }}>Noch keine Vaults angelegt.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {tenants.map((v) => (
              <div key={v.vaultId} style={box}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <div>
                    <span style={{ color: C.text, fontWeight: 600 }}>{v.name}</span>{" "}
                    <span style={{ color: C.textFaint, fontSize: 12 }}>/{v.slug}</span>
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      color: C.textDim,
                      border: `1px solid ${C.border}`,
                      borderRadius: 4,
                      padding: "1px 6px",
                    }}
                  >
                    {v.kind}
                  </span>
                </div>
                <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  {v.tokens.length === 0 ? (
                    <span style={{ color: C.textFaint, fontSize: 12 }}>Keine Tokens.</span>
                  ) : (
                    v.tokens.map((t) => {
                      const revoked = Boolean(t.revokedAt);
                      return (
                        <div
                          key={t.id}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            fontSize: 12,
                            opacity: revoked ? 0.5 : 1,
                          }}
                        >
                          <span style={{ color: C.text, minWidth: 140 }}>{t.agentId}</span>
                          <span style={{ color: C.textDim }}>{t.role}</span>
                          <span style={{ color: C.textFaint, flex: 1 }}>
                            {revoked
                              ? "widerrufen"
                              : t.lastUsedAt
                                ? `zuletzt: ${new Date(t.lastUsedAt).toLocaleString("de-DE")}`
                                : "nie genutzt"}
                          </span>
                          {!revoked && (
                            <button
                              style={{ ...btn(), borderColor: C.err, color: C.err, padding: "4px 10px" }}
                              onClick={() => void revoke(t.id)}
                            >
                              widerrufen
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
