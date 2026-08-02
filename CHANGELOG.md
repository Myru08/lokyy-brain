# Changelog

Alle nennenswerten Änderungen an Lokyy Brain werden hier festgehalten. Die
aktuelle Version steht immer ganz oben.

## Roadmap — woran gerade gearbeitet wird

- **Import-Pipes** (YouTube-Transkripte, Webseiten, PDFs, Sprachnotizen
  direkt in den Vault).
- **Graph-Ansicht ausbauen** und die "ähnliche Notizen"-Vorschläge in der
  Seitenleiste.
- **Weitere Rückmeldungen aus der Community** — meldet gerne, was euch
  auffällt.

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
