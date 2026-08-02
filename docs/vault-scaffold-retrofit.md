# Vault-Grundgerüst nachziehen (Retrofit)

> **Status: portierbereit, noch NICHT portiert.** AC#7 der Story 1.20 verlangt
> die Nutzer-Doku im Live-Repo (`/mnt/projekte/eigene_projekte_neu/lokyy-brain-live`),
> das eine eigene git-History hat. Dieses File ist der Entwurf dafür — Abschnitt
> „Für CHANGELOG.md" und „Für README.md" sind so geschrieben, dass sie 1:1
> übernommen werden können. Der Port ist Sache des Orchestrators.

## Worum es geht

v1.9 (Story 1.19) scaffoldet das Vault-Grundgerüst — kanonische Ordner, die 19
JSON-Schemas, `00_meta/SPEC.md`, die Note-Templates und den SPEC-Pre-Commit-Hook
— **nur beim Fresh Install**. Wer vorher installiert hat, sitzt weiterhin auf
einem faktisch leeren Vault und hat den Hook nie bekommen. Der v1.9-Community-Post
hat genau dafür Nachrüstung zugesagt („melde dich, wenn du die Standard-Struktur
nachträglich haben möchtest") — Story 1.20 löst dieses Versprechen ein.

## Bedienung

**Einstellungen → System → „Vault-Grundgerüst nachziehen"**, drei Schritte:

1. **Struktur prüfen** — Dry-Run. Zeigt, was fehlt und was schon da ist, und
   schreibt garantiert nichts.
2. **Fehlende Dateien anlegen** — legt ausschließlich Fehlendes an. Eigene
   Edits an SPEC.md oder Templates überleben; es wird nie überschrieben.
3. **Hook aktivieren** — bewusst ein eigener, zu bestätigender Schritt.

Dieselben Schritte per API (Admin-Rechte nötig):

```bash
# 1. Plan + Pre-Flight-Zählung (read-only)
curl -s --cookie "lokyy_session=$SESSION" http://localhost:8787/api/admin/vault-scaffold

# 2. Struktur nachziehen, Hook NOCH nicht aktivieren
curl -s -X POST --cookie "lokyy_session=$SESSION" \
  -H 'Content-Type: application/json' -d '{"activateHook": false}' \
  http://localhost:8787/api/admin/vault-scaffold

# 3. Hook aktivieren (nach Sichtung der Zahl aus Schritt 1)
curl -s -X POST --cookie "lokyy_session=$SESSION" \
  -H 'Content-Type: application/json' -d '{"activateHook": true}' \
  http://localhost:8787/api/admin/vault-scaffold
```

## Warum der Hook getrennt bestätigt wird

Der Pre-Commit-Hook lehnt Commits ab, die eine `.md`-Datei ohne SPEC-konformes
Frontmatter anfassen. Für einen frischen Vault ist das folgenlos — es gibt keine
Alt-Notizen. Für einen migrierten Vault kann es viele Dateien betreffen; ein
Community-Mitglied hat ~1400 Dateien importiert.

Deshalb nennt Schritt 1 die Zahl, **bevor** aktiviert wird. Zwei Zahlen, weil die
App strenger validiert als der Hook:

| Zahl       | Bedeutung                                                              |
|------------|------------------------------------------------------------------------|
| `blocking` | Notizen, die der Hook wirklich ablehnen würde. Die relevante Zahl.      |
| `invalid`  | Notizen, die die SPEC laut App-Validierung verletzen (Obermenge).       |

Der Hook grept nur nach `^feld:`; ein `created: 2024-05-01` (Datum ohne Uhrzeit)
passiert ihn, `validateFrontmatter` nicht. Solche Fälle zählen als `invalid`,
aber nicht als `blocking` — sie blockieren nichts.

**Das Risiko ist real, aber begrenzt:** der Hook prüft ausschließlich *gestagte*
Dateien (`git diff --cached --diff-filter=ACM`) und schreibt nie etwas um. Ein
aktivierter Hook sperrt niemanden aus seinem Vault aus; er blockiert erst den
Commit, der eine kaputte Alt-Notiz anfasst. Alles, was durch `notesService` läuft,
ist per Konstruktion SPEC-valide — betroffen sind nur extern importierte Inhalte.

**Reparieren tut das Feature nichts.** Die Zählung ist ein Report. Ein
Frontmatter-Migrationstool ist bewusst eigene, größere Arbeit.

---

## Für CHANGELOG.md (Live-Repo) — übernahmefertig

```markdown
### Neu
- **Bestehende Vaults können die Standard-Struktur nachträglich bekommen.**
  Wer vor v1.9 installiert hat, findet unter Einstellungen → System jetzt
  „Vault-Grundgerüst nachziehen". Erst wird angezeigt, was fehlt (ohne
  irgendetwas zu ändern), dann werden nur die fehlenden Teile angelegt —
  eigene Änderungen an Vorlagen oder Struktur-Regeln bleiben unangetastet.
- **Der Schutz gegen kaputte Notizen wird separat eingeschaltet.** Vorher
  zeigt Lokyy dir, wie viele deiner vorhandenen Notizen die Pflichtangaben
  noch nicht haben. Der Schutz greift nur beim Speichern einer betroffenen
  Notiz — er sperrt dich nie aus deinem Vault aus und ändert nie eine Datei.
```

## Für README.md (Live-Repo) — übernahmefertig

```markdown
### Vor v1.9 installiert?

Die Standard-Struktur (Ordner, Vorlagen, Struktur-Regeln) gab es anfangs nur
bei einer Neuinstallation. Du musst nichts neu aufsetzen: unter
**Einstellungen → System → „Vault-Grundgerüst nachziehen"** siehst du zuerst,
was in deinem Vault fehlt, und ziehst es dann mit einem Klick nach. Bestehende
Dateien werden dabei nie überschrieben.
```

## Technische Referenz

| Baustein                                     | Datei                                     |
|----------------------------------------------|-------------------------------------------|
| Plan/Apply-Split + optionale Hook-Aktivierung | `server/src/setup/scaffoldVault.ts`       |
| Pre-Flight-Zählung (AC#6)                     | `server/src/setup/vaultCompliance.ts`     |
| Admin-Endpoints                               | `server/src/routes/admin.ts`              |
| UI                                            | `pwa/src/Settings.tsx` (`VaultScaffoldPanel`) |
| Differenztest Scan ↔ echter Hook              | `server/src/setup/vaultCompliance.test.ts` |

Der Fresh-Install-Pfad (`server/src/routes/setup.ts`) ist **unverändert**: er ruft
`scaffoldVault()` ohne Optionen auf und behält damit `activateHook: true`.
