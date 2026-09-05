# Story: Dateien und Ordner vom Rechner importieren

> **Tracking issue:** https://github.com/oliverhees/lokyy-brain-dev/issues/63

**Epic:** Import-Pipes
**Umfang (Oliver, 2026-08-14):** Text, Markdown, PDF. Bilder und sonstige Binärdateien später — sie brauchen einen eigenen Upload-Weg, weil sie nicht in den Markdown-Contract passen.

## Ausgangslage

Der Import kann heute nur URLs. `SharePayload.file` und die Multipart-Route `/api/pipes/share` existieren, werden aber nur vom mobilen Share-Target gefüttert und nehmen **genau eine** Datei; `detectType` erkennt davon nur `audio/*`. Im Import-Panel gibt es kein Datei-Feld.

## Akzeptierte Einschränkung

Ordner-Import geht nur auf dem **Desktop** (`webkitdirectory`). Mobile Browser können kein Verzeichnis auswählen. Mehrfachauswahl von Dateien geht überall. Die Oberfläche zeigt das ehrlich an, statt einen toten Knopf anzubieten.

## API-Vertrag — verbindlich für beide Seiten

Der Orchestrator legt ihn fest, damit Server und PWA parallel gebaut werden können.

```
POST /api/pipes/files
Content-Type: multipart/form-data

Felder:
  file          n-mal   — die Dateien
  relativePath  n-mal   — parallel zu `file`, gleiche Reihenfolge.
                          Beim Ordner-Import `webkitRelativePath`,
                          sonst leerer String.
  targetFolder  1-mal   — optional, Zielordner im Vault.
                          Fehlt er, gilt der Default aus den Settings.

Antwort 202:
  {
    jobs:     PipeJob[],                        // ein Job je akzeptierter Datei
    rejected: { name: string; reason: string }[] // benannt abgewiesen, nie still
  }

Antwort 400: { error } — nur wenn gar keine verwertbare Datei dabei war.
```

Ein Job **je Datei**, damit der Fortschritt in der bestehenden Job-Liste sichtbar bleibt.

## Acceptance Criteria

**Server / Core**
1. `POST /api/pipes/files` nimmt N Dateien und legt je Datei einen Job an.
2. Neue Pipe-Typen für Text/Markdown und PDF; `detectType` erkennt sie an MIME **und** Dateiendung (Browser liefern für `.md` oft `application/octet-stream`).
3. Text/Markdown wird zu einer Notiz mit **contract-gültigem Frontmatter** (`id` als ULID, `type`, `title`, `created`, `updated`) — sonst blockt der Pre-Commit-Hook.
4. Bringt eine `.md`-Datei bereits Frontmatter mit, wird es respektiert und nur ergänzt, was fehlt. Eine fremde ULID wird **nicht** übernommen, wenn sie im Vault schon existiert.
5. PDF: Text wird extrahiert und als Notiz abgelegt. Neue Abhängigkeit nötig — es ist keine im Baum.
6. **PDF ohne Textebene** (Scan) ist ein Ergebnis, kein Absturz: der Job endet mit einer Meldung, die das benennt. OCR ist ausdrücklich nicht Teil dieser Story.
7. Beim Ordner-Import bleibt die Struktur erhalten: `relativePath` wird unter `targetFolder` nachgebaut.
8. **Pfad-Sicherheit:** `relativePath` kommt vom Client. `..`, absolute Pfade und Laufwerksbuchstaben dürfen den Vault nicht verlassen. Es gibt bereits `sanitizeTargetFolder` — daran orientieren.
9. **Größenobergrenze** pro Datei und pro Anfrage, konfigurierbar per Env, dokumentiert. Überschreitung wird benannt abgewiesen, der Server stirbt nicht. (`SharePayload.file` ist base64, also +33 % gegenüber der Dateigröße.)
10. Anti: Kein Dateityp wird still verschluckt. Alles Abgewiesene erscheint in `rejected` mit Grund.

**PWA**
11. Datei-Auswahl (Mehrfach) im Import-Panel, auf allen Systemen.
12. Ordner-Auswahl per `webkitdirectory` — **nur sichtbar, wo der Browser es kann**; sonst gar nicht anbieten statt einen toten Knopf zu zeigen.
13. Drag & Drop von Dateien und Ordnern ins Panel.
14. Fortschritt je Datei; abgewiesene Dateien werden mit Grund angezeigt.
15. Anti: Die bestehende URL-Import-Funktion bleibt unverändert bedienbar.

## Verification

- `pnpm -r build`, beide `tsc --noEmit`, alle drei Testsuiten grün
- Route-Test: N Dateien → N Jobs; zu große Datei → `rejected` mit Grund; `../` im `relativePath` landet nicht außerhalb des Vaults
- Handler-Test: `.md` mit und ohne Frontmatter; `.txt`; PDF mit Text; PDF ohne Textebene
- UI: Interceptor-Screenshot des Panels mit Datei- und Ordner-Auswahl

## Definition of Done

Ein Nutzer kann von Mac, Linux, Windows und Handy Dateien in den Vault importieren, auf dem Desktop zusätzlich ganze Ordner mit Struktur. Nicht Unterstütztes wird benannt abgelehnt. `README.md` dokumentiert den Weg.
