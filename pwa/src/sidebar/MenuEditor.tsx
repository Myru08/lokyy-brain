import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, X, Lock, AlertTriangle } from "lucide-react";
import type { TreeNode } from "@lokyy/shared";
import { api, type MenuItem, type ViewType } from "../api.js";
import { C, FONT } from "../theme.js";
import { IconPicker, resolveIcon, type IconName } from "./IconPicker.js";

/**
 * MenuEditor — Zahnrad-Editor für Sidebar-Menüpunkte (Story 11.2).
 *
 * Legt Custom-Menüpunkte an / bearbeitet / löscht sie (Label, Icon, Ordner,
 * View-Typ, Shortcut). System-Items (`kind:"system"`) sind read-only. Speichern
 * geht ausschließlich über `api.putMenu(items)` — KEIN direkter YAML-Write aus
 * der PWA (harte Vault-Regel). Der Server verwirft eingehende `kind:"system"`-
 * Items defensiv (Addendum §3) und generiert/erhält ULIDs.
 *
 * Shortcuts (Entscheidung 30.05., AC 2): Das Shortcut-Feld ist vorhanden. Beim
 * Vergeben wird gegen bestehende Keybindings kollisionsgeprüft (App-Globals +
 * CM6-Defaults, s. RESERVED_SHORTCUTS) sowie gegen andere Custom-Menüpunkte.
 * Ein Konflikt wird klar angezeigt und blockiert das Speichern, bis er
 * aufgelöst ist.
 *
 * [Source: epic-11-architecture-addendum.md §1, §3, §7 (Arch-Punkt 4); Story 11.2]
 */

/* ──────────────────────────────────────────────────────────────────────────
 * Zentrale Keybinding-Registry (Addendum §7 / Arch-Punkt 4).
 *
 * Die belegten Shortcuts der App. Quelle der Wahrheit:
 *   - App.tsx Globals:  Cmd/Ctrl+K (Palette), +O (Quick-Switcher),
 *                       +W (Tab schließen), +S (Speichern).
 *   - CM6 (editor/Editor.tsx): defaultKeymap + historyKeymap — die gängigen
 *     Mod-Editor-Bindings, die wir nicht überschreiben wollen.
 * Normalform: sortierte Modifier ("mod","shift","alt") + key (lowercase),
 * verbunden mit "+". "mod" = Cmd/Ctrl (plattformneutral).
 * ────────────────────────────────────────────────────────────────────── */
interface ReservedBinding {
  combo: string;
  label: string;
}

export const RESERVED_SHORTCUTS: ReservedBinding[] = [
  // App.tsx-Globals
  { combo: "mod+k", label: "Befehlspalette" },
  { combo: "mod+o", label: "Quick-Switcher" },
  { combo: "mod+w", label: "Tab schließen" },
  { combo: "mod+s", label: "Speichern" },
  // CM6 defaultKeymap / historyKeymap (die gebräuchlichen, kollisionsrelevanten)
  { combo: "mod+z", label: "Editor: Rückgängig" },
  { combo: "mod+y", label: "Editor: Wiederherstellen" },
  { combo: "mod+shift+z", label: "Editor: Wiederherstellen" },
  { combo: "mod+a", label: "Editor: Alles markieren" },
  { combo: "mod+enter", label: "Editor: Zeile darunter" },
  { combo: "mod+/", label: "Editor: Kommentar" },
];

/** Normiert ein KeyboardEvent zu einer kanonischen Combo-Form. */
export function comboFromEvent(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  const key = e.key;
  // Reine Modifier-Tasten sind keine vollständige Combo.
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(key)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  const normKey =
    key === " " ? "space" : key.length === 1 ? key.toLowerCase() : key.toLowerCase();
  parts.push(normKey);
  return parts.join("+");
}

/** Hübsche Anzeige einer Combo: "mod+shift+k" → "⌘/Ctrl + Shift + K". */
export function prettyCombo(combo: string): string {
  return combo
    .split("+")
    .map((p) => {
      if (p === "mod") return "⌘/Ctrl";
      if (p === "shift") return "Shift";
      if (p === "alt") return "Alt";
      if (p === "space") return "Space";
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(" + ");
}

/**
 * Findet den ersten Kollisionsgrund für `combo` — gegen reservierte Bindings
 * UND gegen die anderen Custom-Items (`exceptId` ist das gerade editierte
 * Item, das sich nicht mit sich selbst kollidiert). `null` = frei.
 */
export function findShortcutConflict(
  combo: string,
  items: MenuItem[],
  exceptId: string,
): string | null {
  const reserved = RESERVED_SHORTCUTS.find((r) => r.combo === combo);
  if (reserved) return reserved.label;
  const dupe = items.find(
    (it) => it.id !== exceptId && it.shortcut === combo,
  );
  if (dupe) return `Menüpunkt „${dupe.label}"`;
  return null;
}

/* ──────────────────────────────────────────────────────────────────────────
 * ULID-Generator (browser-only, dependency-frei).
 *
 * `@lokyy/core`s `ulid`-Helper ist node-only und darf nie ins Browser-Bundle.
 * Der Server kann beim Persistieren ebenfalls IDs vergeben — aber die PWA
 * braucht eine stabile id, um die Liste lokal zu verwalten, bevor gespeichert
 * wird. Daher hier eine schlanke, SPEC-konforme ULID (26 Zeichen, Crockford-
 * Base32, Zeit-präfix + Zufall). Nutzt `crypto.getRandomValues`.
 * ────────────────────────────────────────────────────────────────────── */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(): string {
  const now = Date.now();
  // 48-bit Zeit → 10 Crockford-Zeichen.
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  // 80-bit Zufall → 16 Crockford-Zeichen.
  const rnd = new Uint8Array(16);
  (globalThis.crypto ?? (window as unknown as { crypto: Crypto }).crypto).getRandomValues(rnd);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += CROCKFORD[rnd[i] % 32];
  return time + rand;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Ordner-Picker: flacht den Vault-Tree zu einer wählbaren Pfadliste ab.
 * "" = Vault-Root. Nur Ordner (keine Notizen).
 * ────────────────────────────────────────────────────────────────────── */
function collectFolders(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === "folder") {
        out.push(n.path);
        if (n.children.length > 0) walk(n.children);
      }
    }
  };
  walk(tree);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

const VIEW_TYPE_OPTIONS: { value: ViewType; label: string }[] = [
  { value: "tree", label: "Ordner-Baum" },
  { value: "skills", label: "Skill-Bibliothek" },
  { value: "dashboard", label: "Dashboard" },
];

interface Draft {
  label: string;
  icon: IconName | string;
  folder: string;
  viewType: ViewType;
  shortcut: string | null;
}

function emptyDraft(): Draft {
  return { label: "", icon: "Folder", folder: "", viewType: "tree", shortcut: null };
}

export function MenuEditor({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);

  // Welches Item wird editiert? null = keines; "new" = Anlegen.
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [menu, tree] = await Promise.all([api.getMenu(), api.tree()]);
        if (!alive) return;
        setItems(menu.items);
        setFolders(collectFolders(tree));
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : "Laden fehlgeschlagen");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const customItems = useMemo(
    () => items.filter((it) => it.kind === "custom"),
    [items],
  );
  const systemItems = useMemo(
    () => items.filter((it) => it.kind === "system"),
    [items],
  );

  // Kollisionsgrund des aktuellen Drafts (null = frei).
  const draftConflict = useMemo(() => {
    if (!draft.shortcut) return null;
    const exceptId = editingId && editingId !== "new" ? editingId : "__new__";
    return findShortcutConflict(draft.shortcut, items, exceptId);
  }, [draft.shortcut, items, editingId]);

  const labelMissing = editingId !== null && draft.label.trim() === "";
  // Speichern blockiert solange ein Shortcut-Konflikt offen ist (AC 2).
  const saveBlocked = draftConflict !== null || labelMissing || saving;

  function startNew() {
    setSaveError(null);
    setDraft(emptyDraft());
    setEditingId("new");
  }

  function startEdit(it: MenuItem) {
    setSaveError(null);
    setDraft({
      label: it.label,
      icon: it.icon,
      folder: it.folder,
      viewType: it.viewType,
      shortcut: it.shortcut,
    });
    setEditingId(it.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setCapturing(false);
    setDraft(emptyDraft());
  }

  /** Übernimmt den Draft in `items` (lokal) — Persistenz erst über Speichern. */
  function applyDraft() {
    if (draftConflict || draft.label.trim() === "") return;
    if (editingId === "new") {
      const item: MenuItem = {
        id: ulid(),
        label: draft.label.trim(),
        icon: draft.icon,
        folder: draft.folder,
        viewType: draft.viewType,
        shortcut: draft.shortcut,
        kind: "custom",
      };
      setItems((prev) => [...prev, item]);
    } else if (editingId) {
      setItems((prev) =>
        prev.map((it) =>
          it.id === editingId
            ? {
                ...it,
                label: draft.label.trim(),
                icon: draft.icon,
                folder: draft.folder,
                viewType: draft.viewType,
                shortcut: draft.shortcut,
              }
            : it,
        ),
      );
    }
    cancelEdit();
  }

  function deleteItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
    if (editingId === id) cancelEdit();
  }

  /** Persistiert alle Custom-Items über die Route (Server filtert System). */
  async function persist() {
    setSaving(true);
    setSaveError(null);
    try {
      // Wir senden nur Custom-Items — der Server droppt System ohnehin.
      const merged = await api.putMenu(items.filter((it) => it.kind === "custom"));
      setItems(merged.items);
      onClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  function onShortcutKeyDown(e: React.KeyboardEvent) {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setCapturing(false);
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      setDraft((d) => ({ ...d, shortcut: null }));
      setCapturing(false);
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // nur Modifier gedrückt → weiter warten
    setDraft((d) => ({ ...d, shortcut: combo }));
    setCapturing(false);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 1100,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(560px, 94vw)",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 10,
          boxShadow: "0 30px 80px rgba(0,0,0,0.5)",
          overflow: "hidden",
          fontFamily: FONT.ui,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: `1px solid ${C.border}`,
          }}
        >
          <div style={{ color: C.text, fontWeight: 600, fontSize: 15 }}>Menü bearbeiten</div>
          <button
            type="button"
            aria-label="Schließen"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: C.textDim,
              cursor: "pointer",
              display: "flex",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 18, overflowY: "auto" }}>
          {loading && (
            <div style={{ color: C.textDim, fontFamily: FONT.mono, fontSize: 12 }}>laden …</div>
          )}
          {loadError && (
            <div style={{ color: C.err, fontFamily: FONT.mono, fontSize: 12 }}>{loadError}</div>
          )}

          {!loading && !loadError && (
            <>
              {/* System-Items (read-only) */}
              {systemItems.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <SectionTitle>System</SectionTitle>
                  {systemItems.map((it) => (
                    <ReadOnlyRow key={it.id} item={it} />
                  ))}
                </div>
              )}

              {/* Custom-Items */}
              <div style={{ marginBottom: 12 }}>
                <SectionTitle>Eigene Menüpunkte</SectionTitle>
                {customItems.length === 0 && editingId !== "new" && (
                  <div
                    style={{
                      color: C.textFaint,
                      fontSize: 12,
                      fontFamily: FONT.mono,
                      padding: "6px 0",
                    }}
                  >
                    Noch keine eigenen Menüpunkte.
                  </div>
                )}
                {customItems.map((it) =>
                  editingId === it.id ? (
                    <DraftForm
                      key={it.id}
                      draft={draft}
                      setDraft={setDraft}
                      folders={folders}
                      conflict={draftConflict}
                      labelMissing={labelMissing}
                      capturing={capturing}
                      setCapturing={setCapturing}
                      onShortcutKeyDown={onShortcutKeyDown}
                      onApply={applyDraft}
                      onCancel={cancelEdit}
                    />
                  ) : (
                    <EditableRow
                      key={it.id}
                      item={it}
                      onEdit={() => startEdit(it)}
                      onDelete={() => deleteItem(it.id)}
                    />
                  ),
                )}

                {/* Neu-Anlegen-Form */}
                {editingId === "new" && (
                  <DraftForm
                    draft={draft}
                    setDraft={setDraft}
                    folders={folders}
                    conflict={draftConflict}
                    labelMissing={labelMissing}
                    capturing={capturing}
                    setCapturing={setCapturing}
                    onShortcutKeyDown={onShortcutKeyDown}
                    onApply={applyDraft}
                    onCancel={cancelEdit}
                  />
                )}
              </div>

              {editingId === null && (
                <button
                  type="button"
                  onClick={startNew}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 12px",
                    background: C.elevated,
                    border: `1px dashed ${C.borderStrong}`,
                    borderRadius: 6,
                    color: C.accent,
                    cursor: "pointer",
                    fontFamily: FONT.ui,
                    fontSize: 13,
                  }}
                >
                  <Plus size={16} /> Menüpunkt hinzufügen
                </button>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "12px 18px",
            borderTop: `1px solid ${C.border}`,
          }}
        >
          <div style={{ color: C.err, fontSize: 12, fontFamily: FONT.mono, flex: 1, minWidth: 0 }}>
            {saveError}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.textDim,
              cursor: saving ? "not-allowed" : "pointer",
              fontFamily: FONT.ui,
              fontSize: 13,
            }}
          >
            Abbrechen
          </button>
          <button
            type="button"
            onClick={persist}
            disabled={editingId !== null || saving}
            title={
              editingId !== null
                ? "Bearbeitung erst übernehmen oder abbrechen"
                : undefined
            }
            style={{
              padding: "8px 16px",
              background: editingId !== null || saving ? C.elevated : C.accent,
              border: "none",
              borderRadius: 6,
              color: editingId !== null || saving ? C.textFaint : "#13171D",
              cursor: editingId !== null || saving ? "not-allowed" : "pointer",
              fontFamily: FONT.ui,
              fontWeight: 600,
              fontSize: 13,
            }}
          >
            {saving ? "speichern …" : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Sub-Komponenten
 * ────────────────────────────────────────────────────────────────────── */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: C.textDim,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function RowIcon({ name }: { name: string }) {
  const Icon = resolveIcon(name);
  return <Icon size={16} />;
}

function ReadOnlyRow({ item }: { item: MenuItem }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: C.bg,
        border: `1px solid ${C.borderSoft}`,
        borderRadius: 6,
        marginBottom: 6,
        color: C.textDim,
      }}
    >
      <RowIcon name={item.icon} />
      <span style={{ flex: 1, fontSize: 13 }}>{item.label}</span>
      {item.shortcut && (
        <span style={{ fontSize: 11, fontFamily: FONT.mono, color: C.textFaint }}>
          {prettyCombo(item.shortcut)}
        </span>
      )}
      <Lock size={13} aria-label="read-only" />
    </div>
  );
}

function EditableRow({
  item,
  onEdit,
  onDelete,
}: {
  item: MenuItem;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        background: C.elevated,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        marginBottom: 6,
        color: C.text,
      }}
    >
      <RowIcon name={item.icon} />
      <button
        type="button"
        onClick={onEdit}
        style={{
          flex: 1,
          textAlign: "left",
          background: "transparent",
          border: "none",
          color: C.text,
          cursor: "pointer",
          fontFamily: FONT.ui,
          fontSize: 13,
          minWidth: 0,
        }}
      >
        {item.label}
      </button>
      {item.shortcut && (
        <span style={{ fontSize: 11, fontFamily: FONT.mono, color: C.textFaint }}>
          {prettyCombo(item.shortcut)}
        </span>
      )}
      <button
        type="button"
        aria-label="Löschen"
        onClick={onDelete}
        style={{
          background: "transparent",
          border: "none",
          color: C.textDim,
          cursor: "pointer",
          display: "flex",
        }}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

function fieldLabelStyle(): React.CSSProperties {
  return {
    display: "block",
    color: C.textDim,
    fontSize: 11,
    fontWeight: 600,
    marginBottom: 4,
    marginTop: 10,
  };
}

function inputStyle(): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 6,
    color: C.text,
    fontFamily: FONT.ui,
    fontSize: 13,
    outline: "none",
  };
}

function DraftForm({
  draft,
  setDraft,
  folders,
  conflict,
  labelMissing,
  capturing,
  setCapturing,
  onShortcutKeyDown,
  onApply,
  onCancel,
}: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  folders: string[];
  conflict: string | null;
  labelMissing: boolean;
  capturing: boolean;
  setCapturing: (v: boolean) => void;
  onShortcutKeyDown: (e: React.KeyboardEvent) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        padding: 14,
        background: C.bg,
        border: `1px solid ${C.accent}`,
        borderRadius: 8,
        marginBottom: 8,
      }}
    >
      <label style={fieldLabelStyle()}>Label</label>
      <input
        value={draft.label}
        onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
        placeholder="z. B. Projekte"
        style={{
          ...inputStyle(),
          borderColor: labelMissing ? C.err : C.border,
        }}
      />
      {labelMissing && (
        <div style={{ color: C.err, fontSize: 11, marginTop: 4 }}>Label darf nicht leer sein.</div>
      )}

      <label style={fieldLabelStyle()}>Icon</label>
      <IconPicker
        value={draft.icon}
        onChange={(name) => setDraft((d) => ({ ...d, icon: name }))}
      />

      <label style={fieldLabelStyle()}>Ordner</label>
      <select
        value={draft.folder}
        onChange={(e) => setDraft((d) => ({ ...d, folder: e.target.value }))}
        style={inputStyle()}
      >
        <option value="">/ (Vault-Root)</option>
        {folders.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>

      <label style={fieldLabelStyle()}>View-Typ</label>
      <select
        value={draft.viewType}
        onChange={(e) => setDraft((d) => ({ ...d, viewType: e.target.value as ViewType }))}
        style={inputStyle()}
      >
        {VIEW_TYPE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label style={fieldLabelStyle()}>Shortcut</label>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          onClick={() => setCapturing(true)}
          onKeyDown={onShortcutKeyDown}
          style={{
            flex: 1,
            textAlign: "left",
            padding: "8px 10px",
            background: capturing ? C.selection : C.elevated,
            border: `1px solid ${conflict ? C.err : capturing ? C.accent : C.border}`,
            borderRadius: 6,
            color: draft.shortcut ? C.text : C.textFaint,
            cursor: "pointer",
            fontFamily: FONT.mono,
            fontSize: 13,
          }}
        >
          {capturing
            ? "Taste(n) drücken … (Esc = Abbruch, ⌫ = leeren)"
            : draft.shortcut
              ? prettyCombo(draft.shortcut)
              : "Kein Shortcut — klicken zum Vergeben"}
        </button>
        {draft.shortcut && (
          <button
            type="button"
            aria-label="Shortcut entfernen"
            onClick={() => setDraft((d) => ({ ...d, shortcut: null }))}
            style={{
              background: "transparent",
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              color: C.textDim,
              cursor: "pointer",
              padding: "6px 8px",
              display: "flex",
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {conflict && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: C.err,
            fontSize: 12,
            marginTop: 6,
          }}
        >
          <AlertTriangle size={14} />
          Shortcut bereits belegt durch: {conflict}. Bitte ändern.
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "7px 12px",
            background: "transparent",
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            color: C.textDim,
            cursor: "pointer",
            fontFamily: FONT.ui,
            fontSize: 13,
          }}
        >
          Abbrechen
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={conflict !== null || draft.label.trim() === ""}
          style={{
            padding: "7px 14px",
            background: conflict !== null || draft.label.trim() === "" ? C.elevated : C.accent,
            border: "none",
            borderRadius: 6,
            color: conflict !== null || draft.label.trim() === "" ? C.textFaint : "#13171D",
            cursor: conflict !== null || draft.label.trim() === "" ? "not-allowed" : "pointer",
            fontFamily: FONT.ui,
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          Übernehmen
        </button>
      </div>
    </div>
  );
}
