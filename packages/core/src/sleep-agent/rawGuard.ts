/**
 * Story S4 — RAW-Immutabilität (verbatim-Garantie).
 *
 * Maßgeblicher Kurs-Vertrag (lokyy-kb-starter):
 *   „RAW bleibt wörtlich — Originale, unveränderlich (Single Source of Truth),
 *    wird NIE umgeschrieben."
 * Zusätzlich gilt für `RAW/_<name>/` (Hände-weg-Zone): durchsucht, aber NIE
 * destilliert / geprüft / vernetzt.
 *
 * Dieses Modul ist die EINE Stelle, an der „ist diese Notiz RAW-unantastbar?"
 * entschieden wird. Alle SYSTEM-getriebenen Schreibpfade des Sleep-Agenten
 * (ULID-Backfill, Peer-Profile-Update, künftige Veredler/Autofix-Passes) und
 * die RAW-lesenden Destillations-/Vernetzungs-Passes (Topic-Synthesis,
 * Entity-Extraction, Lint) fragen hier an, statt das Pfad-Wissen zu duplizieren.
 *
 * Profil-Bewusstsein (AC#3 — `para` bit-identisch):
 *   - Der RAW-Schreibschutz (`isRawImmutable`) greift NUR unter `karpathy`.
 *     `para` kennt kein RAW-Konzept; unter `para` gibt die Funktion IMMER
 *     `false` zurück → Sleep-Agent/Backfill verhalten sich byte-identisch.
 *   - Die Hände-weg-Zone (`isHandsOffZone`) ist rein pfadbasiert und profil-
 *     unabhängig: ein `RAW/_…`-Pfad existiert in einem `para`-Vault per
 *     Konvention gar nicht, also ist das unter `para` ein No-Op und ändert
 *     nichts am Verhalten.
 *
 * Die RAW-Wurzel ist nicht hartkodiert, sondern aus dem S2-Profil-Vertrag
 * (`KARPATHY_TYPE_FOLDER["raw-source"]`) abgeleitet, damit ein künftiger
 * Folder-Rename an EINER Stelle wirkt.
 */

import { KARPATHY_TYPE_FOLDER } from "../frontmatter/profiles.js";
import type { VaultProfile } from "../frontmatter/profiles.js";

/** Kanonische RAW-Wurzel des karpathy-Profils (`"RAW"`), SSOT-abgeleitet. */
export const RAW_ROOT = KARPATHY_TYPE_FOLDER["raw-source"];

/** Pfad normalisieren: `\`→`/`, führende/abschließende Slashes weg. */
function normalize(noteId: string): string {
  return noteId.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * Liegt `noteId` (Pfad ohne `.md`) im RAW-Baum?
 *
 * Segment-genau: `RAW` und `RAW/…` matchen, `RAW_archiv/…` NICHT.
 * Rein pfadbasiert — der Layer-Begriff (`raw-source`) wird hier bewusst NICHT
 * gebraucht, weil der Schutz auch greifen muss, wenn die Frontmatter (noch)
 * keinen `type:` trägt (Legacy-/Import-RAW vor dem Backfill).
 */
export function isUnderRaw(noteId: string): boolean {
  const p = normalize(noteId);
  return p === RAW_ROOT || p.startsWith(`${RAW_ROOT}/`);
}

/**
 * Ist diese RAW-Quelle für SYSTEM-getriebene Rewrites unantastbar?
 *
 * `true` ⇔ Profil `karpathy` UND Pfad unter `RAW/`. Unter `para` IMMER `false`
 * (kein RAW-Konzept → bit-identisches Altverhalten). Aufrufer dürfen RAW LESEN
 * (Destillation liest RAW → schreibt Wiki); sie dürfen nur nicht ZURÜCK-
 * schreiben (weder Body noch Frontmatter), wenn dies `true` liefert.
 */
export function isRawImmutable(
  noteId: string,
  profile: VaultProfile,
): boolean {
  return profile === "karpathy" && isUnderRaw(noteId);
}

/**
 * Liegt `noteId` in der `RAW/_<name>/`-Hände-weg-Zone?
 *
 * Das erste Segment UNTER `RAW/` beginnt mit `_` (z.B. `RAW/_inbox/…`,
 * `RAW/_x/note`). Diese Zone wird von Destillation / Veredler / Prüfung IMMER
 * übersprungen — auch beim reinen Lesen, profil-unabhängig (AC#1 Bullet 3).
 * `RAW/_x` selbst (die Zone-Wurzel als Notiz) zählt ebenfalls.
 */
export function isHandsOffZone(noteId: string): boolean {
  const p = normalize(noteId);
  if (!isUnderRaw(p)) return false;
  const rest = p.slice(RAW_ROOT.length).replace(/^\/+/, "");
  if (rest.length === 0) return false; // `RAW` selbst ist keine `_`-Zone
  const firstSegment = rest.split("/")[0] ?? "";
  return firstSegment.startsWith("_");
}
