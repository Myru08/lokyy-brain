# Lokyy Brain — Roadmap

Diese Roadmap enthält ausschließlich **Funktionserweiterungen und Fehlerbehebungen**. Was fertig ist, steht im [CHANGELOG](CHANGELOG.md); ohne Datumsversprechen — die Reihenfolge kann sich durch euer Feedback ändern.

## In Arbeit — v1.13

### Neue Funktionen

- **Der Beweis-Benchmark.** Ein Messlauf zeigt schwarz auf weiß, was die tiefe Suche bringt: Kosten, Zeit und Treffer — einmal mit, einmal ohne.
- **Nachtlauf pflegt den Vault-Überblick.** Das Inhaltsverzeichnis (`INDEX.md`), das deine KI für die Suchreihenfolge nutzt, wird künftig automatisch jede Nacht aktualisiert statt nur bei Bedarf.

### Verbesserungen & Fehlerbehebungen

- **Notizen löschen, auch wenn Forgejo nicht erreichbar ist.** Speichern, Verschieben und Umbenennen sind seit v1.12 offline-tolerant — Löschen ist der letzte Vorgang, der in dem Fall noch einen Fehler meldet.
- **Widerspruch auflösen wird ein Schritt.** Betrifft ein Widerspruch zwei Notizen, entstehen beim Auflösen aktuell zwei getrennte Speichervorgänge — künftig ist es einer.
- **KI-Arbeitsnotizen landen im richtigen Ordner.** Session-Zusammenfassungen deiner KI können derzeit nicht im dafür vorgesehenen PAI-Bereich des Vaults abgelegt werden und weichen auf den Notizen-Ordner aus.

## Geplant — danach

### Neue Funktionen

- **Import-Pipes ausbauen:** PDFs und Sprachnotizen direkt in den Vault (YouTube-Transkripte und Webseiten funktionieren bereits).
- **Graph-Ansicht ausbauen** — mehr Filter und bessere Navigation im Wissensgraphen.
- **„Ähnliche Notizen"-Vorschläge** in der Seitenleiste, auf Basis der semantischen Suche.
