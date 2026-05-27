import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { api } from "./api.js";
import { C, FONT } from "./theme.js";
import { useIsMobile } from "./responsive.js";
import { VoiceRecorder } from "./VoiceRecorder.js";

type Tab = "url" | "voice";

const FALLBACK_FOLDER = "30_captures";

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

      {/* Panel */}
      <aside
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
                  gap: 6,
                  padding: "10px 0",
                  background: active ? C.elevated : "transparent",
                  border: "none",
                  borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
                  color: active ? C.text : C.textDim,
                  cursor: "pointer",
                  fontSize: 12.5,
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
            const source = job.payload.url ?? job.payload.text ?? "—";
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
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}
