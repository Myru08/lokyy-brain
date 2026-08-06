# Lokyy Brain — Roadmap

Hier steht, woran gerade gebaut wird und was als Nächstes drankommt. Ohne Datumsversprechen — die Reihenfolge kann sich ändern, vor allem durch euer Feedback. Was fertig ist, steht im [CHANGELOG](CHANGELOG.md) und in den Update-Posts in der Community.

## In Arbeit — v1.12

- **Speichern funktioniert immer.** Wenn Forgejo mal nicht erreichbar ist (Container gestoppt, Rechner offline), wird deine Notiz trotzdem sicher lokal gespeichert — statt einer Fehlermeldung siehst du „Lokal gespeichert – Abgleich folgt". Sobald die Verbindung wieder da ist, gleicht Lokyy automatisch ab.
- **Die KI sucht klüger.** Deine KI bekommt eine feste Suchreihenfolge (erst Überblick, dann Suche, dann genau eine Notiz öffnen) — das spart Kosten und liefert bessere Treffer. Dazu kann sie jetzt auf Wunsch die tiefe Suche nutzen, die bisher brachlag.
- **Du siehst, was nachts passiert.** Der nächtliche Pflege-Lauf über deinen Vault bekommt ein Protokoll in der Oberfläche: wann er lief, was er getan hat, welche Notizen er berührt hat.
- **Widersprüche werden sichtbar.** Wenn zwei deiner Notizen sich widersprechen, erscheint ein Warnkasten direkt in der Notiz — mit beiden Aussagen und beiden Quellen. Du entscheidest, was gilt, mit einem Klick.

## Als Nächstes — v1.13

- **Der Beweis.** Ein Messlauf zeigt schwarz auf weiß, was die tiefe Suche bringt: Kosten, Zeit, Treffer — mit und ohne.
- **Nachtlauf erneuert den Vault-Überblick.** Das neue Inhaltsverzeichnis (`INDEX.md`) wird bisher bei Bedarf aufgefrischt; künftig hält der nächtliche Lauf es automatisch aktuell.

## Danach

- **Import-Pipes:** YouTube-Transkripte, Webseiten, PDFs und Sprachnotizen direkt in den Vault.
- **Graph-Ansicht ausbauen** und „ähnliche Notizen"-Vorschläge in der Seitenleiste.
- **Eure Wünsche:** Was euch im Alltag fehlt, meldet ihr am besten direkt in der Community — die Rückmeldungen der letzten Wochen haben diese Roadmap bereits zweimal umsortiert, und das ist gut so.
