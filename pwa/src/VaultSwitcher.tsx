import { useEffect, useState } from "react";
import {
  api,
  getActiveVaultCookie,
  setActiveVaultCookie,
  type VaultListItem,
} from "./api.js";
import { C, FONT } from "./theme.js";

/**
 * Owner vault-switcher (LBMT-C). Sits at the top of the sidebar; lets the owner
 * switch the whole UI between their own vault, customer (Mandanten) and company
 * vaults — grouped by `kind`. Selection is a `lokyy_vault` cookie the server
 * reads to rebind API requests; we reload so tree/dashboard refetch in context.
 * Hidden when there's only one vault (nothing to switch).
 */
const KIND_LABEL: Record<string, string> = {
  personal: "Eigene",
  shared: "Mandanten",
  company: "Firma",
};
const KIND_ORDER = ["personal", "shared", "company"];

export function VaultSwitcher() {
  const [vaults, setVaults] = useState<VaultListItem[] | null>(null);
  // issue #43: >1 vault and no LOKYY_VAULT_ID pin — search/index use the oldest
  // deterministically, but the operator should know the choice is ambiguous
  // (often the fingerprint of an accidental second registration).
  const [ambiguous, setAmbiguous] = useState(false);
  const [open, setOpen] = useState(false);
  const activeId = getActiveVaultCookie();

  useEffect(() => {
    api
      .getVaults()
      .then((r) => {
        setVaults(r.vaults);
        setAmbiguous(r.ambiguous);
      })
      .catch(() => setVaults([]));
  }, []);

  if (!vaults || vaults.length <= 1) return null;

  const current =
    vaults.find((v) => v.id === activeId) ??
    vaults.find((v) => v.isDefault) ??
    vaults[0];

  async function select(v: VaultListItem) {
    // Default/singleton → drop the cookie (no rebind); else pin the vault.
    setActiveVaultCookie(v.isDefault ? null : v.id);
    // A soft reload can be served a STALE app-shell by a stuck service worker
    // (the "needs a hard refresh to see the switcher" symptom). Defeat that for
    // this rare action: unregister the SW + drop its caches, then reload fresh.
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      if (typeof caches !== "undefined") {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      /* SW/caches API unavailable — fall through to a plain reload */
    }
    window.location.reload();
  }

  const groups = KIND_ORDER.map((k) => ({
    kind: k,
    label: KIND_LABEL[k] ?? k,
    items: vaults.filter((v) => v.kind === k),
  })).filter((g) => g.items.length > 0);

  return (
    <div style={{ padding: "8px 8px 0", position: "relative", flexShrink: 0 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          background: C.elevated,
          border: `1px solid ${C.border}`,
          borderRadius: 8,
          padding: "8px 10px",
          color: C.text,
          cursor: "pointer",
          fontFamily: FONT.ui,
          fontSize: 13,
        }}
      >
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0 }}>
          <span style={{ fontSize: 10, color: C.textFaint, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {KIND_LABEL[current.kind] ?? current.kind}
          </span>
          <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
            {current.name}
          </span>
        </span>
        <span style={{ color: C.textDim }}>▾</span>
      </button>
      {ambiguous && (
        <div
          role="alert"
          title="Mehrere Vaults vorhanden und kein LOKYY_VAULT_ID gesetzt. Suche und Indexierung nutzen deterministisch den ältesten Vault. Setze LOKYY_VAULT_ID (oder entferne den überzähligen Vault), um die Mehrdeutigkeit aufzulösen."
          style={{
            marginTop: 6,
            padding: "6px 10px",
            background: "rgba(180,120,0,0.14)",
            border: `1px solid ${C.gold}`,
            borderRadius: 6,
            color: C.gold,
            fontFamily: FONT.ui,
            fontSize: 11,
            lineHeight: 1.35,
          }}
        >
          ⚠︎ Mehrere Vaults, keiner gepinnt — Suche/Index nutzen den ältesten.
          LOKYY_VAULT_ID setzen.
        </div>
      )}
      {open && (
        <div
          style={{
            position: "absolute",
            left: 8,
            right: 8,
            top: "100%",
            marginTop: 4,
            background: C.panel,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            zIndex: 50,
            maxHeight: 360,
            overflowY: "auto",
            padding: "4px 0",
          }}
        >
          {groups.map((g) => (
            <div key={g.kind}>
              <div style={{ fontSize: 10, color: C.gold, textTransform: "uppercase", letterSpacing: "0.04em", padding: "6px 12px 2px" }}>
                {g.label}
              </div>
              {g.items.map((v) => (
                <button
                  key={v.id}
                  onClick={() => select(v)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: v.id === current.id ? C.selection : "transparent",
                    border: "none",
                    color: C.text,
                    padding: "7px 12px",
                    cursor: "pointer",
                    fontFamily: FONT.ui,
                    fontSize: 13,
                  }}
                >
                  {v.name} {v.id === current.id ? "✓" : ""}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
