# Visueller Entwurf — lokyy-brain PWA

`lokyy-brain-mockup.jsx` ist ein **interaktiver Design-Entwurf** der
lokyy-brain-Oberfläche. Er wurde im Vorfeld erstellt und ist die **visuelle
Referenz** für die zu bauende PWA — Layout und Interaktionen sind damit
bereits entworfen und müssen nicht neu erfunden werden.

## Was der Entwurf zeigt

Ein Drei-Panel-Layout:

- **Links:** Datei-Baum / Notizliste mit Tags und Pipes-Inbox.
- **Mitte:** Editor mit Obsidian-artiger Live-Preview — Klick in eine Zeile
  zeigt rohen Markdown, Klick heraus die formatierte Darstellung. Wikilinks
  sind klickbar.
- **Rechts:** Wissensgraph (force-directed), Hover hebt Nachbarn hervor,
  Klick öffnet die Notiz.
- **Oben:** Statusleiste mit Forgejo pull/commit/push-Anzeige.
- **Pipes-Inbox:** zeigt eingehende Importe (YouTube, Voice) bis zur
  fertigen Notiz.

Optik: warmes Dunkel mit Terrakotta-Akzent, Fonts Fraunces /
Bricolage Grotesque / JetBrains Mono.

## Status & Einordnung für BMAD

- Der Entwurf ist ein **Mockup**, kein Produktivcode. Er nutzt `d3-force`
  für den Graphen; die echte PWA soll `react-force-graph` verwenden (siehe
  Briefing). Die Live-Preview ist im Mockup nachgebaut — in der echten PWA
  ist sie eine **CodeMirror-6-Extension** (CM6 ist die Editor-Engine).
- UX-Verhalten, Panel-Aufteilung, Statusanzeigen und der visuelle Stil sind
  als **Vorgabe** zu behandeln. Der Architect/PM kann daraus UX-Anforderungen
  und Komponenten-Schnitt ableiten.
- Abweichungen sind möglich, sollten aber begründet in einer Story
  festgehalten werden — nicht stillschweigend.

Das Mockup lässt sich in einem Vite-React-Sandbox ansehen (Dependencies:
`d3`, `lucide-react`).
