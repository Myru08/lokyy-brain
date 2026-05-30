import { lazy, type ComponentType } from "react";

/**
 * View-Typ-Registry (Frontend) — Story 11.4.
 *
 * Leitprinzip: „Menüpunkt = (Ordner) + (View-Typ)". Ein Menüpunkt (`MenuItem`)
 * trägt einen `viewType`; diese Registry bildet jeden `viewType` auf genau
 * eine Renderer-Komponente ab. So kann die Sidebar einen beliebigen
 * Menüpunkt generisch mounten, ohne den View-Typ fest zu verdrahten.
 *
 * BEWUSST STATISCH: kein Laufzeit-`register()`, kein Plugin-System (KISS, v1).
 * Die `ViewType`-Union ist eine geschlossene Liste. Neue View-Typen werden
 * durch Erweitern dieser Datei + des Records hinzugefügt — nicht zur Laufzeit.
 *
 * INLINE-TYPEN: `MenuItem`/`ViewType` werden hier in der PWA gespiegelt und
 * NICHT aus `@lokyy/core` importiert. `@lokyy/core` ist node-only und darf nie
 * im Browser-Bundle landen (Addendum §0). Die kanonische Quelle der Typen ist
 * `packages/core/src/workspace/menuConfig.ts` (Addendum §1/§2) — dieser Mirror
 * muss strukturell deckungsgleich bleiben.
 *
 * [Source: epic-11-architecture-addendum.md §2]
 */

/** Geschlossene Liste der View-Typen v1 (Spiegel von core `ViewType`). */
export type ViewType = "tree" | "skills" | "dashboard";

/**
 * Menüpunkt — PWA-Inline-Spiegel von core `MenuItem`. Strukturell
 * deckungsgleich mit `packages/core/src/workspace/menuConfig.ts`.
 */
export interface MenuItem {
  /** ULID (custom) oder reservierte System-Konstante ("system:home", …). */
  id: string;
  label: string;
  /** lucide-react Icon-Name. */
  icon: string;
  /** Vault-relativer Ordnerpfad ("" = Vault-Root). */
  folder: string;
  viewType: ViewType;
  shortcut: string | null;
  kind: "system" | "custom";
}

/**
 * Einheitliches, minimales Props-Interface für jeden Renderer. Der Renderer
 * entscheidet selbst, ob er `item.folder` braucht (`tree` ja; `skills`/
 * `dashboard` haben einen fixen Ordner bzw. ignorieren ihn).
 *
 * Kein eigener Routing-/Editor-State: `onOpenNote` delegiert in `App.open()`.
 *
 * [Source: epic-11-architecture-addendum.md §2]
 */
export interface ViewProps {
  /** Der aktive Menüpunkt (label / folder / icon / viewType). */
  item: MenuItem;
  /** Öffnet eine Notiz — delegiert in `App.open()`. Kein lokaler State. */
  onOpenNote: (noteId: string) => void;
}

export type ViewRenderer = ComponentType<ViewProps>;

/**
 * Echter Renderer (Story 11.4). Lazy geladen — gleiche `lazy()`-Praxis wie
 * `GraphView` in `App.tsx` —, damit die Registry-Auswertung keinen der
 * View-Chunks synchron auf den Boot-Pfad zieht.
 */
const TreeView = lazy(() =>
  import("./TreeView.js").then((m) => ({ default: m.TreeView })),
);

/**
 * K-1: `skills` (11.5) und `dashboard` (11.11) werden in dieser Story NICHT
 * angelegt. Bis die echten Dateien existieren, referenziert die Registry sie
 * als lazy „Coming soon"-Stubs — typvollständig und lazy, ohne 11.5/11.11 zu
 * blockieren und ohne einen kaputten `import()` auf eine nicht existierende
 * Datei (tsc/Vite würden sonst brechen).
 *
 * Sobald 11.5 / 11.11 die echten Dateien anlegen, wird der jeweilige Stub
 * durch den realen Lazy-Import ersetzt:
 *   const SkillsView = lazy(() =>
 *     import("./SkillsView.js").then((m) => ({ default: m.SkillsView })));
 *   const DashboardView = lazy(() =>
 *     import("./DashboardView.js").then((m) => ({ default: m.DashboardView })));
 *
 * [Source: epic-11-architecture-addendum.md §2 + K-1]
 */
function comingSoonStub(label: string): ViewRenderer {
  const ComingSoon: ComponentType<ViewProps> = () => ComingSoonElement(label);
  return lazy(() => Promise.resolve({ default: ComingSoon }));
}

/**
 * Echter Renderer (Story 11.5) — Skill-Bibliothek. Lazy geladen (gleiche
 * `lazy()`-Praxis wie `TreeView`/`GraphView`), damit der Skills-Chunk nicht
 * synchron auf den Boot-Pfad gezogen wird.
 */
const SkillsView = lazy(() =>
  import("./SkillsView.js").then((m) => ({ default: m.SkillsView })),
);
const DashboardView: ViewRenderer = /* TODO(11.11): import("./DashboardView.js") */ comingSoonStub(
  "Dashboard",
);

/**
 * Statischer Record `viewType → Renderer`. Geschlossen über `ViewType`, sodass
 * der Compiler einen vollständigen Mapping-Beweis erzwingt: fehlt ein Key,
 * bricht tsc.
 *
 * [Source: epic-11-architecture-addendum.md §2]
 */
export const VIEW_REGISTRY: Record<ViewType, ViewRenderer> = {
  tree: TreeView,
  skills: SkillsView, // Platzhalter (11.5)
  dashboard: DashboardView, // Platzhalter (11.11)
};

/**
 * Löst einen `viewType` zu seinem Renderer auf. Unbekannt → Default `tree`
 * (defensiv gegen handgepfuschte Menü-Config; spiegelt den Read-Fallback in
 * core, der bei invaliden Daten nie crasht).
 *
 * [Source: epic-11-architecture-addendum.md §2]
 */
export function resolveView(viewType: ViewType): ViewRenderer {
  return VIEW_REGISTRY[viewType] ?? VIEW_REGISTRY.tree;
}

/* ------------------------------------------------------------------ */
/* Inline-„Coming soon"-Fallback (JSX-frei, damit diese .ts-Datei kein
 * TSX braucht — die echten Views liefern 11.5/11.11). */

import { createElement, type ReactElement } from "react";
import { C, FONT } from "../../theme.js";

function ComingSoonElement(label: string): ReactElement {
  return createElement(
    "div",
    {
      style: {
        padding: "24px 16px",
        color: C.textDim,
        fontFamily: FONT.ui,
        fontSize: 13,
        lineHeight: 1.6,
      },
    },
    createElement(
      "div",
      {
        style: {
          color: C.gold,
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          marginBottom: 6,
        },
      },
      label,
    ),
    createElement(
      "div",
      { style: { fontFamily: FONT.mono, color: C.textFaint } },
      "Coming soon",
    ),
  );
}
