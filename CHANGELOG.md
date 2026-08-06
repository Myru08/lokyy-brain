# Changelog

Alle nennenswerten Änderungen an Lokyy Brain werden hier festgehalten. Die
aktuelle Version steht immer ganz oben.

## Roadmap — woran gerade gearbeitet wird

- **Der Beweis:** ein Messlauf, der zeigt, was die tiefe Suche bringt —
  Kosten, Zeit, Treffer, mit und ohne.
- **Nachtlauf pflegt den Vault-Überblick:** das neue Inhaltsverzeichnis
  (`INDEX.md`) wird künftig automatisch nachts aktualisiert.
- **Import-Pipes ausbauen** (PDFs und Sprachnotizen direkt in den Vault).
- **Graph-Ansicht ausbauen** und die "ähnliche Notizen"-Vorschläge in der
  Seitenleiste.
- Die vollständige Liste steht in der [ROADMAP.md](ROADMAP.md).

---

## v1.12.6 — 2026-08-06

### Behoben
- **Der Update-Fortschritt bewegt sich jetzt wirklich.** Die Anzeige blieb beim ersten Schritt („Prüfen") stehen, während das Update im Hintergrund komplett durchlief. Ursache war ausgerechnet die Laufzeit-Uhr aus v1.12.4: Sie ließ das Fenster jede Sekunde neu zeichnen und setzte dabei die Statusabfrage zurück, bevor diese je stattfinden konnte. Behoben — die Abfrage läuft jetzt unabhängig davon weiter, und die Schritte wandern wieder mit.

---

## v1.12.5 — 2026-08-06

### Behoben
- **Speichern unter Windows funktioniert wieder.** Bei Windows-Installationen konnte die interne Prüfdatei des Vaults (`.githooks/pre-commit`) durch die anderen Zeilenende-Zeichen unausführbar werden — jedes Speichern brach dann mit „cannot run .githooks/pre-commit" ab. Lokyy repariert diese Datei jetzt automatisch beim Start; zusätzlich kann sie gar nicht mehr falsch ausgecheckt werden. **Notizen waren nie in Gefahr** — sie lagen die ganze Zeit auf der Festplatte, nur die Versionierung scheiterte.
- **Der Update-Vorgang bleibt nicht mehr scheinbar hängen.** Blieb der Fortschritt in einem Schritt stehen, obwohl das Update längst lief, sah es aus wie ein Absturz. Jetzt weist Lokyy auf ungewöhnlich lange Schritte hin, erkennt selbstständig an der laufenden Version, dass das Update fertig ist, und endet notfalls mit einer klaren Ansage statt endlosem Drehen.

---

## v1.12.4 — 2026-08-06

### Neu
- **Update-Punkt direkt in der Kopfleiste.** Ein Klick prüft sofort auf neue Versionen („Alles aktuell" mit Zeitpunkt) — und gibt es eine, wird das Symbol orange, zeigt die neue Version an und startet das Update direkt. Kein Weg mehr über die Einstellungen nötig.

### Behoben
- **Der Update-Dialog wirkt beim Bauen nicht mehr eingefroren:** Der aktive Schritt pulsiert sichtbar, beim längsten Schritt („Bauen") steht ehrlich dabei, dass er je nach Rechner mehrere Minuten dauert, und eine mitlaufende Zeitanzeige zeigt, dass gearbeitet wird.

---

## v1.12.3 — 2026-08-06

### Behoben
- **Der Aktualisieren-Knopf steht jetzt direkt in den Einstellungen.** Bisher zeigte die Versions-Karte nur einen Hinweis auf den Banner „oben in der App" — jetzt startest du das Update genau dort, wo du es entdeckst. Und der Banner erscheint nach einer manuellen Prüfung sofort, ohne die Seite neu laden zu müssen.
- **Der Installer richtet den Ein-Klick-Updater automatisch ein.** Bei vielen Installationen fehlte das dafür nötige Geheimnis in der `.env` — der Update-Knopf konnte deshalb nichts ausführen und verwies auf den manuellen Weg. `./install.sh` bzw. `.\install.ps1` erzeugen es ab sofort selbst; einmal ausführen genügt, bestehende Werte werden nie überschrieben.

---

## v1.12.2 — 2026-08-06

### Behoben
- **Nacht-Protokoll repariert:** Die Einträge wurden zusammengequetscht dargestellt und zeigten aufgeklappt kaum Inhalt. Jetzt: nach Tagen gruppiert, volle Karten, und aufgeklappt eine verständliche Liste der Arbeitsschritte — inklusive ehrlicher Fehleranzeige, wenn ein Schritt nicht geklappt hat.
- **Ein interner Fehler im nächtlichen Aufräum-Schritt** (Datum statt Text übergeben) ließ diesen Schritt bei jedem Lauf scheitern — behoben; ab jetzt liefert der Nachtlauf wieder vollständige Ergebnisse.

---

## v1.12.1 — 2026-08-06

### Neu
- **Lokyy sucht jetzt selbst nach Updates:** automatisch dreimal am Tag, plus ein „Jetzt prüfen"-Knopf unter Einstellungen → System, der sofort nachsieht.

### Behoben
- **Neue Versionen wurden bis zu sechs Stunden lang nicht angezeigt**, weil nur beim Start geprüft wurde — genau deshalb hättest du dieses Update sonst erst heute Nachmittag gesehen.

---

## v1.12 — 2026-08-06

### Behoben
- **Speichern meldet keinen Fehler mehr, wenn Forgejo gerade nicht erreichbar ist.** Die Notiz war in diesem Fall schon immer lokal sicher gespeichert — jetzt sagt Lokyy das auch: ein goldener Hinweis „Lokal gespeichert – Sync ausstehend" statt einer roten Fehlermeldung. Der nächste Save oder Sync gleicht automatisch ab.

### Neu
- **Widersprüche stehen jetzt in der Notiz.** Findet Lokyy widersprüchliche Aussagen, erscheint ein farbiger Warnkasten direkt in der betroffenen Notiz — mit beiden Aussagen und beiden Quellen. Du entscheidest, was gilt, und löst den Fund per Klick auf. Dazu eine Liste aller offenen Funde im Kopfbereich.
- **Deine KI sucht klüger und günstiger.** Feste Suchreihenfolge für angebundene KIs (erst Vault-Überblick, dann Suche, dann genau eine Notiz), ein automatisch gepflegtes Inhaltsverzeichnis (`get_index`) — und die tiefe 8-Stufen-Suche ist jetzt zuschaltbar, die normale Suche bleibt sofort und kostenlos.
- **Nacht-Protokoll:** Die neue Ansicht zeigt, wann der nächtliche Pflege-Lauf lief, was er getan hat und welche Notizen er berührt hat.
- **Öffentliche Roadmap:** In der neuen [ROADMAP.md](ROADMAP.md) steht, woran als Nächstes gebaut wird.

---

## v1.11 — 2026-08-03

### Lokyy Brain ist jetzt Open Source
- **Lizenz: AGPL-3.0.** Der Quellcode ist öffentlich. Du darfst Lokyy Brain
  nutzen, verändern und weitergeben — privat wie geschäftlich, auch für deine
  eigenen Kunden. Die einzige Bedingung greift, wenn jemand eine *veränderte*
  Version als Netzwerkdienst anbietet: dann muss er seinen Quellcode
  offenlegen. Wer normal betreibt, hat keinerlei Verpflichtung.
- **Kein GitHub-Login mehr nötig**, um das Repo zu klonen. Der Umweg über die
  Anmeldung entfällt ersatzlos.
- **Fork ist beim Remote-Deployment keine Voraussetzung mehr**, nur noch eine
  Option für alle, die eigene Änderungen deployen wollen. Kein Deploy-Key,
  keine Zugangsdaten.
- Beiträge sind willkommen — siehe `CONTRIBUTING.md`.

### Neu
- **Dein MCP-Zugangsschlüssel wird jetzt in Lokyy selbst verwaltet.** Bisher
  musstest du dafür eine Konfigurationsdatei bearbeiten und den Stack neu
  starten. Jetzt findest du unter Einstellungen → MCP einen Bereich, in dem du
  einen Schlüssel erzeugst, kopierst und jederzeit wieder ungültig machst —
  samt fertigem Verbindungsblock zum Einfügen in deine KI. Änderungen wirken
  sofort, ohne Neustart.
- **Bei der Einrichtung wird automatisch ein eigener Schlüssel erzeugt** und
  dir einmalig angezeigt. Bitte gleich kopieren: aus Sicherheitsgründen wird er
  nur verschlüsselt gespeichert und lässt sich später nicht wieder anzeigen —
  nur neu erzeugen.
- **Jede Installation bekommt ihren eigenen Schlüssel.** Bis v1.10 lieferte
  Lokyy einen fertigen Standard-Schlüssel mit, damit man sofort loslegen kann,
  ohne sich vorher mit Schlüsseln zu beschäftigen — für die erste Beta-Phase
  auf dem eigenen Rechner der richtige Kompromiss. Jetzt, wo Installationen im
  Alltag und teils auf eigenen Servern laufen, bekommt jede ihren eigenen.
  Bestehende Installationen: einmal unter Einstellungen → MCP „Token erzeugen"
  und den neuen Schlüssel in der KI hinterlegen. Der Standard-Schlüssel
  funktioniert weiterhin, damit nichts abreißt; die Einstellungen weisen darauf
  hin, solange er in Gebrauch ist.

### Behoben
- **Die MCP-Anbindung funktioniert direkt nach der Installation.** Bisher
  blieb sie nach einer frischen Installation stumm, bis der Stack einmal neu
  gestartet wurde — auch mit korrektem Schlüssel.
- **Achtung, geänderte Adresse: Forgejo liegt jetzt auf Port 8790**, vorher
  3001. Wenn du ein Lesezeichen auf `http://localhost:3001` hattest, zeigt es
  ins Leere — die Oberfläche ist nicht weg, sie ist umgezogen:
  `http://localhost:8790`. Grund: 3000/3001 sind auf vielen Rechnern schon von
  anderen Programmen belegt. Der SSH-Port 2222 ist ersatzlos entfallen, er
  wurde nie gebraucht und war eine häufige Konfliktquelle.
- **Der Installer öffnet den Browser erst, wenn wirklich alles bereit ist.**
  Bisher konnte nach einer frischen Installation das Login-Formular statt des
  Einrichtungsassistenten erscheinen: die Oberfläche war schon da, der Server
  dahinter aber noch am Hochfahren. `install.sh`/`install.ps1` und
  `lokyy.sh start`/`lokyy.ps1 start` warten jetzt auf beides.

---

## v1.10 — 2026-08-02

### Neu
- **Bestehende Vaults können die Standard-Struktur nachträglich bekommen.**
  Wer vor v1.9 installiert hat, findet unter Einstellungen → System jetzt
  "Vault-Grundgerüst nachziehen". Erst wird angezeigt, was fehlt (ohne
  irgendetwas zu ändern), dann werden nur die fehlenden Teile angelegt —
  eigene Änderungen an Vorlagen oder Struktur-Regeln bleiben unangetastet.
- **Der Schutz gegen kaputte Notizen wird separat eingeschaltet.** Vorher
  zeigt Lokyy dir, wie viele deiner vorhandenen Notizen die Pflichtangaben
  noch nicht haben. Der Schutz greift nur beim Speichern einer betroffenen
  Notiz — er sperrt dich nie aus deinem Vault aus und ändert nie eine Datei.

---

## v1.9 — 2026-08-02

### Neu
- **Der Vault startet jetzt mit vollständiger Struktur.** Bisher war nach
  der Installation praktisch ein leerer Ordner da. Jetzt sind alle
  Standard-Ordner (Projekte, Notizen, Aufnahmen, Entscheidungen,
  Meetings, Kunden, Ideen, Archiv …), Vorlagen für neue Notizen und die
  Struktur-Regeln von Anfang an angelegt.
- **Schutz gegen kaputte Notizen.** Der Vault prüft jetzt selbst beim
  Speichern, ob eine Notiz die Pflichtangaben hat, und blockiert sonst.
  So kann die Struktur nicht mit der Zeit verrotten.

### Behoben
- **Erstinstallation bleibt nicht mehr hängen.** Unter bestimmten
  Bedingungen konnte der allererste Start abbrechen, bevor der
  Einrichtungsassistent überhaupt erreichbar war.
- **Neues Forgejo-Repository anlegen funktioniert wieder.** Der Weg über
  den Einrichtungsassistenten scheiterte bisher an einer zu eng gefassten
  Berechtigung.
- **System-Status zeigt Forgejo korrekt an.** Die Übersicht meldete
  teilweise "nicht verbunden", obwohl alles lief.
- **Aufgeräumte Deploy-Konfiguration** für alle, die remote (z. B. über
  Coolify) hosten — überflüssige Container entfernt, Forgejo-Version
  aktualisiert.

---

## v1.8 — 2026-08-02

### Behoben
- **Semantische Suche funktioniert jetzt zuverlässig.** Neu gespeicherte
  Notizen werden vollständig für die KI-gestützte Bedeutungssuche erfasst —
  vorher lief nur die reine Stichwortsuche durchgängig.
- **Zuverlässigere Fehlermeldungen bei KI-Anbindungen (MCP).** Ein
  fehlgeschlagener Schreibvorgang wurde bisher teils fälschlich als
  erfolgreich gemeldet. Das ist jetzt korrigiert.
