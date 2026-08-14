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

## v1.18.0 — 2026-08-14

### Behoben
- **Die intelligente Suche gewichtet endlich, wie sie soll.** Lokyy berechnet nächtlich die Wichtigkeit jeder Notiz — diese Werte kamen bei der Suche nie an, weil sie unter einem anderen Schlüssel lagen. Jede Notiz galt als durchschnittlich. Jetzt zählen auch Aufrufe und Bearbeitungen mit.
- **Ganze Ordner löschen räumt jetzt vollständig auf.** Beim Löschen einzelner Notizen stimmte seit v1.17 alles; wurde ein ganzer Ordner gelöscht oder verschoben, blieben die Sucheinträge der enthaltenen Notizen liegen.
- **Der Nachtlauf sagt jetzt, WELCHE Notiz Ärger macht.** Bisher stand im Protokoll nur eine Fehlerzahl. Jetzt steht zu jedem Fehler die betroffene Notiz und der Grund dabei — bei jedem Arbeitsschritt, nicht nur bei einem.

### Neu
- **Die Diagnose findet Karteileichen.** Unter *Einstellungen → Diagnose* gibt es den neuen Punkt „Abgeleitete Stores (Verwaisungen)": er zeigt, ob irgendwo noch Einträge zu Notizen liegen, die es nicht mehr gibt. Reine Anzeige — es wird nichts gelöscht.

### Danke
Die Ordner-Lücke und die Idee, Fehler mit Notiz und Grund zu melden, gehen auf den Testbericht aus der Community zurück, der schon v1.17 ausgelöst hat. Der Rest kam beim Aufräumen selbst ans Licht.

---

## v1.17.0 — 2026-08-14

### Behoben
- **Gelöschte und verschobene Notizen hinterlassen keine Reste mehr in der semantischen Suche.** Bisher wurde nur der Volltext-Index aufgeräumt — beim Verschieben und im Papierkorb genauso. Falsche Treffer gab es nicht, aber der Ballast wuchs mit jeder Löschung.
- **Fehlende semantische Einträge lassen sich endlich nachziehen.** War der Embedding-Dienst beim Speichern nicht erreichbar, blieb die Notiz dauerhaft ohne Eintrag — es half nur erneutes Speichern, Notiz für Notiz. Jetzt holt der Nachtlauf das nach, und du kannst es selbst anstoßen.
- **Die Diagnose zeigt jetzt, ob die semantische Suche überhaupt befüllt ist.** Unter *Einstellungen → Diagnose* steht neu „note_embeddings befüllt“. Der Check sagt ausdrücklich dazu, dass „Suchindex neu aufbauen“ hier nicht hilft — das baut nur den Volltext-Index.
- **Der Nachtlauf verschweigt keine Fehler mehr.** Die Entitäten-Erkennung brach bei längeren Notizen mitten in der Antwort ab und zählte das stumm mit. Jetzt reicht der Platz, und wenn doch etwas abbricht, stehen Grund und Notiz im Protokoll.
- **Lokale KI-Modelle bekommen mehr Zeit.** Ohne Grafikkarte dauert ein Modellaufruf oft länger als die bisherige feste 60-Sekunden-Grenze — der Nachtlauf-Schritt konnte also nie fertig werden. Jetzt sind es fünf Minuten, einstellbar über `LOKYY_OLLAMA_TIMEOUT_MS`.

### Danke
Alle fünf Punkte gehen auf einen ausführlichen Testbericht aus der Community zurück — inklusive selbst nachgestellter Messungen. Genau so wird das Ding besser.

---

## v1.16.0 — 2026-08-13

### Behoben
- **Das Update direkt in Lokyy funktioniert wieder — besonders unter Windows.** Der In-App-Update brach mit „lokale Änderungen" ab, obwohl man nichts geändert hatte (Windows speichert Zeilenende-Zeichen anders als der Linux-Container → jede Datei sah „verändert" aus). Lokyy erkennt diese harmlosen Unterschiede jetzt und aktualisiert normal; echte eigene Änderungen stoppen das Update weiterhin.
- **„Privacy Max": das lokale KI-Modell installiert sich jetzt sauber.** Das Modell (`llama3.1`) war zwar konfiguriert, aber nicht heruntergeladen — und das wurde nicht angezeigt. Jetzt zeigt Einstellungen → AI-Provider → Lokale Modelle klar installiert/fehlt an und installiert das Modell mit einem Klick (Fortschritt); der Test-Knopf prüft die echte Präsenz.

---

## v1.15.0 — 2026-08-13

### Behoben
- **Sehr lange Dokumente landen jetzt vollständig in der intelligenten Suche.** Große Notizen waren zu groß fürs Suchmodell und wurden dabei komplett übersprungen — Ursache war eine zu optimistische Größen-Schätzung (deutsche/technische Texte zählen anders als englische Prosa). Lokyy rechnet jetzt konservativ und zerlegt lange Notizen sauber; nichts fällt mehr raus.
- **Bei mehr als einem Vault war unklar, welcher gesucht wurde.** Eine Zweitregistrierung konnte still einen zweiten Datenspeicher anlegen, danach zeigten Suche und Ablage evtl. auf verschiedene. Jetzt wählt Lokyy immer eindeutig denselben Vault für beides; bei mehreren weist die Oberfläche darauf hin.
- **Über die App-/Weboberfläche wurden bisher gar keine semantischen Einträge gespeichert** (ein interner Verknüpfungsfehler mit dem gewählten Vault) — mitbehoben. Die semantische Suche funktioniert damit auf allen Wegen, nicht nur über die KI. *(Korrektur, nachgetragen mit v1.17: Für ältere betroffene Notizen gab es damals noch keinen Nachzieh-Weg — die Zusage an dieser Stelle war falsch. Seit v1.17 holt der Nachtlauf-Schritt „embedding-backfill“ das tatsächlich nach, und du kannst es auch selbst anstoßen.)*

---

## v1.14.0 — 2026-08-13

### Behoben
- **Die intelligente (semantische) Suche funktioniert wieder, wenn deine KI den Vault über MCP befüllt.** Dem lokalen MCP-Container fehlte eine Einstellung — dadurch wurden im Hintergrund keine Embeddings erzeugt und die Suche fiel still auf reinen Volltext zurück, obwohl alles gesund aussah. Behoben, mit Wächter gegen Rückfall. Neue Notizen werden wieder korrekt semantisch indexiert. *(Korrektur, nachgetragen mit v1.17: „ältere zieht der Nachtlauf nach“ stimmte nicht — einen solchen Nachtlauf-Schritt gab es damals nicht. Seit v1.17 gibt es ihn.)*
- **Löschen funktioniert jetzt auch offline.** War Forgejo nicht erreichbar, brach Löschen mit einer technischen Meldung ab (als letzter nicht-offline-toleranter Vorgang). Jetzt wird lokal gespeichert und später synchronisiert — wie beim Speichern.

### Sicherheit
- Aufbauend auf dem Login-Schutz aus v1.13: Browser-Cache wird bei Abmeldung geleert, Sitzungs-Cookie hinter HTTPS abgesichert (`LOKYY_COOKIE_SECURE`), interne Token-Vergleiche gehärtet.

### Hinweis
- Die lokale Installation ist standardmäßig nur vom eigenen Rechner erreichbar. Für Netzwerk-/Fernzugriff genügt jetzt **eine** Einstellung: `LOKYY_BIND_ADDR=0.0.0.0` (für echten Fernzugriff zusätzlich Reverse-Proxy + HTTPS, siehe docs/DEPLOY.md).

---

## v1.13.0 — 2026-08-08

### Sicherheit
- **Die API verlangt jetzt für alle Daten-Routen eine Anmeldung.** Notizen, Vault, Graph, Suche, Import, Dashboard und Einstellungen antworten ohne gültige Session mit 401 — bisher waren sie nach dem Setup ohne Login erreichbar. Deine Notizen waren nie verändert; es ging allein darum, wer sie lesen darf.
- **Die lokale Installation hört jetzt nur noch auf 127.0.0.1** statt offen im Netzwerk; CORS ist auf eine konfigurierbare Origin-Liste beschränkt statt Wildcard.

### Behoben
- **Aufbau und Update auf dem Mac funktionieren wieder.** Zwei nur in der Groß-/Kleinschreibung verschiedene Dateien ließen den Build auf macOS abbrechen — behoben, plus ein Wächter gegen diese Fehlerklasse.

### Hinweis
- Bei abgelaufener Session führt die Oberfläche jetzt zum Login zurück; das Teilen von Inhalten verlangt eine aktive Anmeldung.

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
