# Changelog

Alle nennenswerten Änderungen an Lokyy Brain werden hier festgehalten. Die
aktuelle Version steht immer ganz oben.

## Roadmap — woran gerade gearbeitet wird

- **Erstinstallation zuverlässiger machen.** In seltenen Fällen kann der
  allererste Start hängen bleiben, bevor der Einrichtungsassistent
  erreichbar ist.
- **Forgejo-Verbindung beim Anlegen eines neuen Repositories.** Aktuell kann
  es dabei zu einer Fehlermeldung kommen; der Weg über ein bereits
  bestehendes Repository funktioniert einwandfrei.
- **Status-Anzeige korrigieren.** Die System-Übersicht zeigt Forgejo teils
  fälschlich als "nicht verbunden" an, obwohl alles läuft.
- **Deploy-Konfiguration aufräumen** für alle, die remote (z. B. über
  Coolify) hosten.

---

## v1.8 — 2026-08-02

### Behoben
- **Semantische Suche funktioniert jetzt zuverlässig.** Neu gespeicherte
  Notizen werden vollständig für die KI-gestützte Bedeutungssuche erfasst —
  vorher lief nur die reine Stichwortsuche durchgängig.
- **Zuverlässigere Fehlermeldungen bei KI-Anbindungen (MCP).** Ein
  fehlgeschlagener Schreibvorgang wurde bisher teils fälschlich als
  erfolgreich gemeldet. Das ist jetzt korrigiert.
