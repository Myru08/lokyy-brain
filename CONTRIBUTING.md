# Beitragen zu Lokyy Brain

Schön, dass du hier bist. Lokyy Brain steht unter der **AGPL-3.0** — du darfst
es nutzen, verändern und weitergeben, ohne jemanden zu fragen. Wenn du eine
Verbesserung zurückgeben willst, umso besser.

## Verhaltenskodex

Für dieses Projekt gilt der [Contributor Covenant v2.1](CODE_OF_CONDUCT.md) —
der Standard, den die meisten Open-Source-Projekte verwenden. Kurz: geh
respektvoll miteinander um. Wenn dir etwas begegnet, das dagegen verstößt,
melde es bei [@oliverhees](https://github.com/oliverhees).

## Bevor du loslegst

**Öffne zuerst ein Issue.** Auch für kleine Sachen. Das kostet dich zwei
Minuten und erspart dir im Zweifel einen Nachmittag Arbeit an etwas, das
gerade schon jemand anderes baut oder das bewusst so ist, wie es ist.

Bei Fehlern hilft: was hast du gemacht, was ist passiert, was hättest du
erwartet. Wenn du an die Logs kommst (`./lokyy.sh doctor`), häng sie an.

## Was hilfreich ist

- **Ein Thema pro Pull Request.** Ein PR, der einen Fehler behebt *und*
  nebenbei aufräumt, ist schwer zu prüfen und schwer zurückzunehmen.
- **Tests für alles, was Verhalten ändert.** `pnpm -r test` muss grün bleiben,
  `pnpm -r build` ebenfalls. Ein Test, der auch gegen den kaputten Zustand
  grün ist, hilft niemandem — prüf das ruhig kurz nach, indem du den Fehler
  absichtlich wieder einbaust.
- **Doku im selben PR.** Ändert sich etwas, das ein Nutzer oder Betreiber
  merkt, gehört die Anpassung von README, `MCP-INTEGRATION.md` oder
  `docs/DEPLOY.md` dazu — nicht in einen Folge-PR.
- **Schreib auf Deutsch oder Englisch**, wie es dir leichter fällt. Beides ist
  in diesem Projekt normal.
- **KI-generierter Code ist willkommen** — Lokyy ist ein KI-Werkzeug, es wäre
  seltsam, das zu verbieten. Du musst nicht angeben, womit du gearbeitet hast.
  Aber der Code ist deiner: du hast ihn gelesen, verstanden und getestet.
  Erkennbar ungeprüfte Einreichungen schließen wir mit einem Verweis hierher.

## Contributor License Agreement (CLA)

Mit dem Einreichen eines Beitrags stimmst du dem Folgenden zu:

1. **Du behältst dein Urheberrecht.** Dein Beitrag gehört weiterhin dir.

2. **Du räumst uns zusätzliche Rechte ein.** Du gewährst Oliver Hees ein
   dauerhaftes, weltweites, unwiderrufliches, kostenfreies und
   unterlizenzierbares Recht, deinen Beitrag zu nutzen, zu vervielfältigen,
   zu verändern und zu verbreiten — auch unter **anderen Lizenzbedingungen
   als der AGPL-3.0**.

3. **Du versicherst, dass du das darfst:** der Beitrag stammt von dir, oder du
   hast die nötigen Rechte daran. Falls du im Rahmen eines Arbeitsverhältnisses
   beiträgst, hast du die Zustimmung deines Arbeitgebers.

4. **Ohne Gewährleistung.** Du stellst den Beitrag ohne Zusicherungen zur
   Verfügung, soweit gesetzlich zulässig.

### Warum das nötig ist

Die AGPL ist Copyleft. Ohne diese Vereinbarung wäre jeder fremde Beitrag
dauerhaft an die AGPL gebunden — und das Projekt könnte seine Lizenz nie mehr
ändern, ohne jeden einzelnen Beitragenden aufzuspüren und um Erlaubnis zu
bitten. In der Praxis heißt das: ein Projekt mit dreißig Beitragenden kann
faktisch nie mehr umlizenzieren.

Das CLA hält diese Tür offen. Es nimmt dir **nichts** weg: dein Beitrag bleibt
dein, und er bleibt in Lokyy Brain unter AGPL — daran ändert sich nichts, und
niemand kann dir die veröffentlichte Fassung wieder wegnehmen.

Das ist dasselbe Modell, das Grafana, Elastic, Qt und viele andere fahren. Wenn
dir das nicht passt, ist das völlig legitim — dann freuen wir uns über ein
gutes Issue statt über Code. Ein präzise beschriebener Fehler ist oft mehr wert
als der Patch.

## Ablauf

1. Issue öffnen (oder ein bestehendes übernehmen)
2. Forken, Branch anlegen
3. Bauen und testen: `pnpm -r build && pnpm -r test`
4. Pull Request mit Bezug aufs Issue

Fragen? Mach ein Issue auf oder schreib [@oliverhees](https://github.com/oliverhees).

Und wenn du gar nicht programmierst, aber trotzdem helfen willst: die
wertvollsten Hinweise kommen aus der Praxis — „das habe ich nicht verstanden",
„hier bin ich hängengeblieben". Der Ort dafür ist die Community:
**[aiianer.de](https://aiianer.de)**.
