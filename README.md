# lokyy-brain

Eigenständiges, Obsidian-nahes Knowledge-Tool. Läuft als Web-App **und** als
installierbare PWA. **Forgejo ist die Wahrheit** — der Server hält die einzige
echte Git-Working-Copy, die Clients machen selbst kein Git.

> Umbenannt aus dem Arbeitstitel "Sternwarte" auf `lokyy-brain` mit
> Package-Scope `@lokyy/*`. Historische Verweise auf den alten Namen finden sich
> nur noch in den BMAD-Planning-Artefakten unter `_bmad-output/` und in dieser
> Rename-Note.

## Architektur

```
┌─────────────┐   HTTP/JSON    ┌──────────────┐   git pull/commit/push   ┌─────────┐
│  PWA (Vite) │ ─────────────▶ │ Server (Hono)│ ───────────────────────▶ │ Forgejo │
│  CM6 Editor │ ◀───────────── │ Working-Copy │ ◀─────────────────────── │  (Wahr- │
│  Graph      │                │  + Pipes     │                          │   heit) │
└─────────────┘                └──────────────┘                          └─────────┘
   IndexedDB                    .md auf Disk
   (Offline-Cache)              (Source of Truth lokal)
```

Drei Schichten, je eine klare Aufgabe:

1. **PWA** — UI, CM6-Editor mit Live-Preview, Graph. Hält einen Offline-Cache
   in IndexedDB, queued Saves bei fehlender Verbindung.
2. **Server** — die einzige Git-Working-Copy. Stellt Notizen, Graph und Pipes
   als JSON-API bereit. Beim Speichern: `add → commit → pull --rebase → push`.
3. **Forgejo** — Remote, Versionierung, Wahrheit.

### Der Sync-Flow

- **Notiz öffnen / Tab wieder aktiv** → Server macht `git pull --rebase`.
- **Speichern** → Server schreibt die `.md`, dann `add` · `commit` · `pull --rebase` · `push`.
- **Konflikt** entsteht nur bei gleichzeitiger Änderung *derselben Zeilen* — als
  Einzelnutzer über mehrere Geräte praktisch nie.
- **Offline** → PWA editiert gegen den IndexedDB-Cache, queued Saves, spielt sie
  beim Reconnect über denselben commit/rebase/push-Pfad ein.

## Datei-Baum & Struktur

Der Vault *ist* die Ordnerstruktur — eine Notiz-id wie `pai/hermes` ist
schlicht ihr Pfad. Der Datei-Baum links bildet das ab und kann es
verändern: Notizen und Ordner **anlegen**, **umbenennen**, per
Drag & Drop **verschieben**, **löschen**. Jede Operation läuft über den
Git-Service, also direkt nach Forgejo. Leere Ordner bekommen eine
`.gitkeep`, weil Git keine leeren Verzeichnisse trackt.

API dafür unter `/api/vault` (`tree`, `note`, `folder`, `move`, `entry`).

## Pipes & Import

Eine kleine getypte Job-Queue (`server/src/pipes/`). Zwei Eingänge:

- **Web Share Target** — die PWA registriert sich im Manifest, geteilte
  URLs / Sprachnachrichten landen am `POST /api/pipes/share`.
- **Import-Panel** — das Slide-over von rechts: URL einfügen, Typ wählen
  (YouTube, Website-Seite, ganze Website crawlen, oder automatisch
  erkennen), `POST /api/pipes/import`. Es pollt die Queue und zeigt jeden
  Job bis zur fertigen Notiz.

Beide nutzen dieselbe Queue und dieselben Handler. Mitgeliefert:
`youtube` (Transkript via Supadata), `url` (einzelne Seite scrapen),
`crawl` (ganze Website). Importe landen im `inbox/`-Ordner — erst
capturen, später einsortieren. Ein neuer Pipe = ein neuer Handler.

> Hinweis: **Web Share Target funktioniert nicht auf iOS** — dort braucht
> es einen Fallback (Shortcut, der ans Backend postet). Auf
> Android/Chrome/Desktop läuft es nativ. Das Import-Panel funktioniert
> überall.

## Workspaces

| Paket              | Zweck                                                  |
|--------------------|--------------------------------------------------------|
| `packages/shared`  | Geteilte Typen (Note, TreeNode, GraphData, PipeJob).   |
| `server`           | Hono-API, Git-Service, Vault-Struktur, Pipes.          |
| `pwa`              | Vite-SPA + PWA, CM6-Editor, Datei-Baum, Import-Panel.  |

## Setup

```bash
pnpm install

# Server
cp server/.env.example server/.env   # VAULT_DIR, GIT_REMOTE, SUPADATA_API_KEY ...
pnpm --filter server dev

# PWA
pnpm --filter pwa dev
```

Beim ersten Start klont der Server `GIT_REMOTE` nach `VAULT_DIR` (falls leer).

## Deployment

Server + PWA laufen auf jedem kleinen Linux-VPS. Server braucht ein
installiertes `git` und SSH-Key/Token-Zugriff auf das Forgejo-Repo. PWA als
statisches Build hinter dem Server oder einem Reverse-Proxy.

## Status

Gerüst, typgeprüft, PWA baut sauber durch. Funktional angelegt:

- Git-Service (clone, pull, save, move/rename, remove) — Forgejo als Wahrheit
- Notes- & Graph-Service, Datei-Baum mit voller Struktur-Bearbeitung
- CM6-Editor mit Live-Preview + Wikilink-Parsing
- Pipes-Queue mit YouTube-, Scrape- und Crawl-Handler
- Import-Panel (Slide-over) + Web-Share-Target-Manifest

Offen: Graph-Frontend (react-force-graph), IndexedDB-Offline-Layer,
Auth, Whisper-Handler für Sprachnachrichten, Bundle-Splitting.
