# Changelog

Alle nennenswerten Änderungen an Lokyy Brain werden hier festgehalten. Die
aktuelle Version steht immer ganz oben.

## Roadmap — woran gerade gearbeitet wird

- **Update-Knopf direkt in Lokyy.** Beim Start wird geprüft, ob eine neue
  Version da ist; ein Banner weist dich darauf hin, und ein Klick spielt sie
  ein. Damit entfällt der Weg übers Terminal.
- **Eigenes Datenbank-Passwort je Installation** statt des mitgelieferten
  Standardwerts — bestehende Installationen laufen unverändert weiter.
- **Import-Pipes** (YouTube-Transkripte, Webseiten, PDFs, Sprachnotizen
  direkt in den Vault).
- **Graph-Ansicht ausbauen** und die "ähnliche Notizen"-Vorschläge in der
  Seitenleiste.
- **Weitere Rückmeldungen aus der Community** — meldet gerne, was euch
  auffällt.

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
