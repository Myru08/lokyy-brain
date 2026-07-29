#!/usr/bin/env bash
# lokyy.sh — Lokyy Brain im Alltag steuern (macOS und Linux).
#
# install.sh ist der EINMALIGE Einstieg (Docker installieren, Images bauen).
# Dieses Script hier ist der Alltag DANACH: starten, anhalten, nachschauen.
# Es setzt voraus, dass install.sh schon einmal erfolgreich durchgelaufen ist —
# es installiert selbst kein Docker und baut auch keine Images neu.
#
# Die fünf Befehle:
#   start     Stack starten, auf die Web-UI warten, Browser öffnen
#   stop      Stack anhalten (Container bleiben erhalten, nächster Start ist schnell)
#   restart   Container neu starten
#   status    Kurzer Überblick: Container + Erreichbarkeit (nur lesend)
#   doctor    Ausführliche Diagnose (nur lesend — ändert NICHTS von selbst)
#
# Aufruf — beides funktioniert:
#   bash lokyy.sh start
#   ./lokyy.sh start      (falls das Ausführ-Recht gesetzt ist)
#
# Gut zu wissen: alle Dienste in docker-compose.local.yml haben
# "restart: unless-stopped". Nach einem Neustart des Rechners fährt der Stack
# also von allein wieder hoch, sobald Docker selbst läuft — ./lokyy.sh start
# brauchst du dafür nicht.
#
# Exit-Codes (wie in install.sh):
#   0  alles gut
#   1  Aufruf ohne (oder mit unbekanntem) Befehl — oder Docker fehlt ganz
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  die Aktion ist fehlgeschlagen (start/stop/restart) bzw. doctor hat
#      Probleme gefunden

# -u  = Zugriff auf nicht gesetzte Variablen ist ein Fehler (fängt Tippfehler).
# -o pipefail = eine fehlgeschlagene Pipe-Stufe macht die ganze Pipe rot.
# Absichtlich KEIN -e: wir prüfen jeden Schritt selbst und wollen dabei immer
# eine verständliche deutsche Meldung ausgeben, statt still abzubrechen.
set -uo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Konfiguration — dieselben Werte wie in install.sh
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE_FILE="docker-compose.local.yml"
PWA_URL="http://localhost:8095"
API_URL="http://localhost:8787"
MCP_URL="http://localhost:8788/mcp"
FORGEJO_URL="http://localhost:8790"

# Ports, die docker-compose.local.yml auf dem Host belegt.
# Format "Port:Beschriftung" — bewusst eine einfache Liste statt eines
# assoziativen Arrays, weil macOS noch mit bash 3.2 ausgeliefert wird und
# assoziative Arrays dort nicht existieren.
PORTS_TO_CHECK="8787:Server-API 8095:Web-UI-(PWA) 8788:MCP-Server 8790:Forgejo-Web-UI"

# Wie lange warten wir maximal, bis die Web-UI antwortet?
MAX_WAIT_SECONDS=90
POLL_INTERVAL_SECONDS=2

# Zeilenumbruch als Variable — damit ein Diagnose-Hinweis samt Befehlsvorschlag
# als EIN Eintrag gespeichert und trotzdem zweizeilig ausgegeben werden kann.
NL=$'\n'

# Der einmalige Init-Container: lädt das Embedding-Modell in Ollama und beendet
# sich danach. "Exited (0)" ist bei ihm der NORMALZUSTAND, kein Fehler.
ONESHOT_SERVICE="ollama-init"

# ─────────────────────────────────────────────────────────────────────────────
# Ausgabe-Helfer — Farben nur, wenn wir wirklich in einem Terminal schreiben
# (bei Umleitung in eine Datei würden Steuerzeichen sonst nur stören)
# ─────────────────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi

say()   { printf '%s\n' "$*"; }
step()  { printf '%s\n' "${C_BLUE}==>${C_RESET} ${C_BOLD}$*${C_RESET}"; }
ok()    { printf '%s\n' "    ${C_GREEN}OK${C_RESET}  $*"; }
warn()  { printf '%s\n' "    ${C_YELLOW}!${C_RESET}   $*"; }
fail()  { printf '%s\n' "    ${C_RED}FEHLER${C_RESET}  $*"; }

# ─────────────────────────────────────────────────────────────────────────────
# In den Ordner wechseln, in dem DIESES Script liegt.
# Damit ist egal, aus welchem Verzeichnis du es aufrufst — die Compose-Datei
# wird immer relativ zum Repo gefunden.
# ─────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -z "${SCRIPT_DIR}" ] || ! cd "${SCRIPT_DIR}"; then
  fail "Konnte nicht in den Script-Ordner wechseln. Bitte das Repo neu herunterladen."
  exit 4
fi

OS_KERNEL="$(uname -s 2>/dev/null || echo unknown)"

# ─────────────────────────────────────────────────────────────────────────────
# Gemeinsame Helfer
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  say ""
  say "${C_BOLD}lokyy.sh${C_RESET} — Lokyy Brain im Alltag steuern"
  say ""
  say "  Aufruf:  ./lokyy.sh <Befehl>"
  say ""
  say "    ${C_BOLD}start${C_RESET}     Stack starten, auf die Web-UI warten, Browser öffnen"
  say "    ${C_BOLD}stop${C_RESET}      Stack anhalten (Container bleiben erhalten)"
  say "    ${C_BOLD}restart${C_RESET}   Container neu starten"
  say "    ${C_BOLD}status${C_RESET}    Überblick: Container + Erreichbarkeit (nur lesend)"
  say "    ${C_BOLD}doctor${C_RESET}    Ausführliche Diagnose (nur lesend)"
  say ""
  say "  Die Erst-Installation macht ${C_BOLD}install.sh${C_RESET} — auch neue Images baut nur die."
  say ""
}

# Kurzform für alle Compose-Aufrufe auf unsere Datei.
compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

# Ist docker überhaupt da? Wenn nicht: klar sagen und raus — dieses Script
# installiert bewusst nichts, das ist die Aufgabe von install.sh.
require_docker_cli() {
  if command -v docker >/dev/null 2>&1; then
    return 0
  fi
  fail "Docker ist nicht installiert — führe zuerst install.sh aus."
  exit 1
}

# Läuft der Docker-Daemon wirklich? Das ist der häufigste Stolperstein:
# der Befehl "docker" existiert, aber dahinter antwortet niemand.
require_docker_daemon() {
  if docker info >/dev/null 2>&1; then
    return 0
  fi

  fail "Docker ist installiert, aber der Docker-Daemon antwortet nicht."
  say ""
  if [ "${OS_KERNEL}" = "Darwin" ]; then
    say "  Bitte starte ${C_BOLD}Docker Desktop${C_RESET} (Programme-Ordner oder Spotlight)"
    say "  und warte, bis das Wal-Symbol in der Menüleiste \"running\" meldet."
  elif [ "${OS_KERNEL}" = "Linux" ]; then
    say "  Bitte starte den Docker-Dienst:"
    say ""
    say "      ${C_BOLD}sudo systemctl start docker${C_RESET}"
  else
    say "  Bitte starte Docker Desktop und warte, bis es \"running\" meldet."
  fi
  say ""
  say "  Danach diesen Befehl einfach noch einmal aufrufen."
  say ""
  exit 2
}

require_compose_file() {
  if [ -f "${COMPOSE_FILE}" ]; then
    return 0
  fi
  fail "Die Datei ${COMPOSE_FILE} liegt nicht im Projekt-Ordner."
  say "    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde."
  exit 4
}

# Prüft, ob auf einem Port bereits etwas lauscht.
# Rückgabe: 0 = belegt, 1 = frei.
is_port_in_use() {
  local port
  port="$1"

  if command -v nc >/dev/null 2>&1; then
    # -z = nur verbinden, nichts senden; -w 1 = maximal 1 Sekunde warten.
    # </dev/null stellt sicher, dass ein nc ohne -z-Unterstützung sofort
    # ein EOF bekommt und nicht auf Eingabe wartet (sonst würde das Script hängen).
    if nc -z -w 1 "localhost" "${port}" </dev/null >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi

  # Fallback ohne Zusatzprogramme: bash kann selbst TCP-Verbindungen öffnen.
  # In einer Subshell (…) — dann schließt sich der Dateideskriptor von allein.
  if (exec 3<>/dev/tcp/localhost/"${port}") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Antwortet eine unserer Adressen? Uns interessiert NUR, ob eine Verbindung
# zustande kommt — welcher HTTP-Status zurückkommt, ist hier egal.
# Rückgabe: 0 = erreichbar, 1 = nicht erreichbar.
is_url_reachable() {
  local url port
  url="$1"
  port="$2"

  if command -v curl >/dev/null 2>&1; then
    curl --silent --output /dev/null --max-time 3 "${url}" >/dev/null 2>&1
    return $?
  fi

  # Fallback ohne curl: reiner TCP-Verbindungstest über bash.
  if (exec 3<>/dev/tcp/localhost/"${port}") >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Best-effort-Diagnose: WER hält einen Port? Bewusst OHNE sudo — eine
# unerwartete Passwort-Abfrage mitten in einer Meldung ist die schlechtere
# Erfahrung. Ohne Root-Rechte bleibt die Prozess-Spalte womöglich leer, die
# Belegung sieht man trotzdem. Ohne Fund folgt der Hinweis, wie man mit
# Administrator-Rechten weiterkommt.
print_port_holder() {
  local port holder
  port="$1"
  holder=""

  if command -v ss >/dev/null 2>&1; then
    holder="$(ss -tulpn 2>/dev/null | grep ":${port} ")"
  fi
  if [ -z "${holder}" ] && command -v lsof >/dev/null 2>&1; then
    holder="$(lsof -i ":${port}" 2>/dev/null)"
  fi
  if [ -z "${holder}" ]; then
    # Vielleicht hält ein ganz anderes Docker-Projekt den Port.
    holder="$(docker ps --filter "publish=${port}" --format '{{.Names}}  ({{.Image}})' 2>/dev/null)"
  fi

  if [ -n "${holder}" ]; then
    say "        Belegt von:"
    printf '%s\n' "${holder}" | while IFS= read -r holder_line; do
      say "          ${holder_line}"
    done
  else
    say "        Wer den Port hält, war ohne Administrator-Rechte nicht zu sehen."
    say "        Mehr Details:  ${C_BOLD}sudo ss -tulpn | grep ${port}${C_RESET}"
  fi
}

# Wartet, bis die Web-UI antwortet. Jeder Punkt = ein Versuch.
# Rückgabe: 0 = die Seite antwortet, 1 = Zeit abgelaufen.
wait_for_pwa() {
  local attempts i
  attempts=$((MAX_WAIT_SECONDS / POLL_INTERVAL_SECONDS))

  printf '    '
  i=1
  while [ "${i}" -le "${attempts}" ]; do
    if is_url_reachable "${PWA_URL}" 8095; then
      printf '\n'
      return 0
    fi
    printf '.'
    sleep "${POLL_INTERVAL_SECONDS}"
    i=$((i + 1))
  done
  printf '\n'
  return 1
}

# macOS kennt "open", die meisten Linux-Desktops "xdg-open". Gibt es beides
# nicht (z. B. auf einem Server ohne Oberfläche), geben wir nur die URL aus.
open_browser() {
  if command -v open >/dev/null 2>&1; then
    open "${PWA_URL}" >/dev/null 2>&1 &
    ok "Browser wird geöffnet."
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "${PWA_URL}" >/dev/null 2>&1 &
    ok "Browser wird geöffnet."
  else
    warn "Kein Browser-Starter gefunden — bitte die Adresse von Hand öffnen:"
    say "    ${C_BOLD}${PWA_URL}${C_RESET}"
  fi
}

print_endpoints() {
  say ""
  say "  ${C_BOLD}Web-UI (hier geht es los)${C_RESET}   ${PWA_URL}"
  say "  Server-API                  ${API_URL}"
  say "  MCP-Endpoint                ${MCP_URL}"
  say "  Forgejo (optional)          ${FORGEJO_URL}"
  say ""
  say "${C_BOLD}Nützliche Befehle${C_RESET}"
  say "  Status:    ./lokyy.sh status"
  say "  Diagnose:  ./lokyy.sh doctor"
  say "  Logs:      docker compose -f ${COMPOSE_FILE} logs -f"
  say "  Anhalten:  ./lokyy.sh stop"
  say ""
}

# Gemeinsamer Abschluss von start und restart: warten, Browser, Zusammenfassung.
finish_with_pwa() {
  step "Warten, bis die Web-UI erreichbar ist (max. ${MAX_WAIT_SECONDS} Sekunden)"

  if wait_for_pwa; then
    ok "Web-UI antwortet unter ${PWA_URL}"
  else
    warn "Die Web-UI hat nach ${MAX_WAIT_SECONDS} Sekunden noch nicht geantwortet."
    say "    Wir öffnen den Browser trotzdem — lade die Seite in ein bis zwei"
    say "    Minuten einfach neu."
    say "    Status ansehen:  ${C_BOLD}./lokyy.sh status${C_RESET}"
  fi

  step "Browser öffnen"
  open_browser

  say ""
  say "${C_GREEN}${C_BOLD}Lokyy Brain läuft.${C_RESET}"
  print_endpoints
}

# ─────────────────────────────────────────────────────────────────────────────
# start — Stack hochfahren
#
# Bewusst OHNE --build: das ist der schnelle Alltags-Start. Wer nach einem
# Update des Codes wirklich neu bauen muss, ruft install.sh auf — dort ist
# --build zu Hause, und nur dort.
#
# Zwei bekannte, selbstheilbare Fehlerbilder fangen wir wie install.sh ab:
# ein Port-Rest aus einem früheren Lauf und ein durcheinandergeratener
# BuildKit-Content-Store. Beides kann auch ohne --build auftreten.
# ─────────────────────────────────────────────────────────────────────────────

# Startet den Stack und legt die Ausgabe in ${COMPOSE_LOG} ab.
# Rückgabe: der Exit-Code von docker compose — NICHT der von tee. Genau dafür
# ist PIPESTATUS da (bash-Erweiterung; dieses Script läuft per Shebang in bash).
compose_up() {
  compose up -d 2>&1 | tee "${COMPOSE_LOG}"
  return "${PIPESTATUS[0]}"
}

cmd_start() {
  require_docker_cli
  require_docker_daemon
  require_compose_file

  step "Lokyy Brain starten"

  # Wir brauchen die Ausgabe von Compose zweimal: live auf dem Bildschirm UND
  # als Datei, um sie im Fehlerfall auswerten zu können. Beides zugleich = tee.
  # Kein Suffix nach den X-en: das mag das mktemp von macOS/BSD nicht.
  COMPOSE_LOG="$(mktemp "${TMPDIR:-/tmp}/lokyy-compose-XXXXXX" 2>/dev/null)"
  if [ -z "${COMPOSE_LOG}" ]; then
    COMPOSE_LOG="/tmp/lokyy-compose-$$"
  fi

  say ""
  compose_up
  COMPOSE_EXIT=$?
  say ""

  # Zwei bekannte, selbstheilbare Fehlerbilder. Alles andere (kein Internet,
  # kein Speicherplatz) wird NICHT wiederholt.
  if [ "${COMPOSE_EXIT}" -ne 0 ] && grep -q "port is already allocated" "${COMPOSE_LOG}" 2>/dev/null; then
    warn "Ein Port ist noch belegt — das sieht nach einem Rest aus einem früheren Start aus."
    say "    Wir räumen den alten Stack automatisch ab und versuchen es genau einmal erneut."
    say ""
    compose down --remove-orphans >/dev/null 2>&1

    # "down" kehrt zurück, sobald Docker die Container entfernt hat — der
    # dazugehörige docker-proxy-Prozess gibt den Host-Port dabei aber nicht
    # IMMER synchron frei. Ein sofortiger Retry kann deshalb genau denselben
    # Fehler nochmal auslösen. Deshalb hier aktiv warten, bis alle benötigten
    # Ports laut TCP-Check wirklich frei sind (max. 10 Sekunden).
    ports_wait_deadline=10
    ports_waited=0
    while [ "${ports_waited}" -lt "${ports_wait_deadline}" ]; do
      still_busy=0
      for entry in ${PORTS_TO_CHECK}; do
        port="${entry%%:*}"
        if is_port_in_use "${port}"; then
          still_busy=1
          break
        fi
      done
      [ "${still_busy}" -eq 0 ] && break
      sleep 1
      ports_waited=$((ports_waited + 1))
    done

    compose_up
    COMPOSE_EXIT=$?
    say ""
  elif [ "${COMPOSE_EXIT}" -ne 0 ] && grep -qE "lease does not exist|unable to lease content" "${COMPOSE_LOG}" 2>/dev/null; then
    # Bekannter BuildKit/containerd-Aussetzer: der Build-Content-Store ist
    # durcheinander. "docker builder prune" räumt nur den Cache auf —
    # Container, Volumes und der Vault bleiben unangetastet.
    warn "Der Docker-Build-Cache scheint durcheinander zu sein (bekannter BuildKit-Aussetzer)."
    say "    Wir räumen den Cache automatisch auf und versuchen es genau einmal erneut."
    say ""
    docker builder prune -f >/dev/null 2>&1
    compose_up
    COMPOSE_EXIT=$?
    say ""
  fi

  if [ "${COMPOSE_EXIT}" -ne 0 ]; then
    fail "Der Start ist fehlgeschlagen (docker compose Exit-Code ${COMPOSE_EXIT})."
    say ""

    # Steht in der Meldung ein konkreter Port? Dann sagen wir auch gleich,
    # WER ihn hält — statt den Menschen selbst auf die Suche zu schicken.
    CONFLICT_PORT="$(grep -oE '0\.0\.0\.0:[0-9]+|Bind for [^ ]*:[0-9]+' "${COMPOSE_LOG}" 2>/dev/null | grep -oE '[0-9]+$' | head -n 1)"
    if [ -n "${CONFLICT_PORT}" ]; then
      say "    Port ${C_BOLD}${CONFLICT_PORT}${C_RESET} ist belegt — auch nach dem automatischen Aufräumen."
      print_port_holder "${CONFLICT_PORT}"
      say ""
      say "    Bitte dieses Programm beenden (oder in ${COMPOSE_FILE} einen anderen"
      say "    Port eintragen) und ${C_BOLD}./lokyy.sh start${C_RESET} erneut aufrufen."
      say ""
    fi

    say "    Die Fehlermeldung von Docker steht direkt darüber."
    say "    Mehr Details:  ${C_BOLD}./lokyy.sh doctor${C_RESET}"
    say "    Logs ansehen:  ${C_BOLD}docker compose -f ${COMPOSE_FILE} logs${C_RESET}"
    say ""
    rm -f "${COMPOSE_LOG}"
    exit 4
  fi

  rm -f "${COMPOSE_LOG}"
  ok "Container gestartet."

  finish_with_pwa
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# stop — Feierabend
#
# Bewusst "stop" und NICHT "down": "stop" hält die Container nur an, lässt sie
# aber samt Netzwerk bestehen. Der nächste Start muss dadurch nichts neu
# anlegen und ist entsprechend schnell. Für die Daten macht es ohnehin keinen
# Unterschied — Vault, Datenbank und Modelle liegen in Volumes und überleben
# beides. "down" braucht man nur, wenn man wirklich aufräumen will.
# ─────────────────────────────────────────────────────────────────────────────

cmd_stop() {
  require_docker_cli
  require_docker_daemon
  require_compose_file

  step "Lokyy Brain anhalten"
  say ""

  if ! compose stop; then
    say ""
    fail "Das Anhalten ist fehlgeschlagen — die Meldung von Docker steht darüber."
    exit 4
  fi

  say ""
  ok "Lokyy Brain ist angehalten. Weiter geht es mit ${C_BOLD}./lokyy.sh start${C_RESET}."
  say ""
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# restart — Container durchstarten (z. B. nach einer Änderung an der Env)
# ─────────────────────────────────────────────────────────────────────────────

cmd_restart() {
  require_docker_cli
  require_docker_daemon
  require_compose_file

  step "Lokyy Brain neu starten"
  say ""

  if ! compose restart; then
    say ""
    fail "Der Neustart ist fehlgeschlagen — die Meldung von Docker steht darüber."
    say "    Mehr Details:  ${C_BOLD}./lokyy.sh doctor${C_RESET}"
    exit 4
  fi

  say ""
  ok "Container neu gestartet."

  finish_with_pwa
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# status — schneller Überblick, rein lesend
# ─────────────────────────────────────────────────────────────────────────────

# Eine Adresse prüfen und das Ergebnis als Zeile ausgeben.
check_endpoint() {
  local label url port
  label="$1"
  url="$2"
  port="$3"

  if is_url_reachable "${url}" "${port}"; then
    ok "${label}  ${url}"
  else
    warn "${label}  ${url}  — antwortet nicht"
  fi
}

cmd_status() {
  require_docker_cli
  require_docker_daemon
  require_compose_file

  step "Container"
  say ""
  # Bewusst "ps -a": ohne -a versteckt Compose beendete Container — und damit
  # ausgerechnet den einmaligen Init-Container, über den man sonst rätselt.
  compose ps -a
  say ""
  say "    Hinweis: ${C_BOLD}${ONESHOT_SERVICE}${C_RESET} steht auf \"Exited (0)\" — das ist der"
  say "    Normalzustand. Dieser Container lädt einmalig das Embedding-Modell"
  say "    und beendet sich danach; er muss NICHT laufen."
  say ""

  step "Erreichbarkeit"
  check_endpoint "Web-UI       " "${PWA_URL}" 8095
  check_endpoint "Server-API   " "${API_URL}" 8787
  check_endpoint "MCP-Endpoint " "${MCP_URL}" 8788
  say ""
  say "    (Der MCP-Endpoint antwortet ohne Bearer-Token mit einem Fehler —"
  say "     hier zählt nur, DASS er antwortet.)"
  say ""
  exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# doctor — ausführliche Diagnose
#
# Wichtig: doctor ist REIN LESEND. Er stoppt nichts, räumt nichts auf und
# startet nichts neu — er sagt nur, was er sieht, und schlägt den passenden
# Befehl vor. Die beiden automatischen Selbstheilungen (Port-Rest aufräumen,
# Build-Cache aufräumen) stecken bewusst in "start" und nur dort.
# ─────────────────────────────────────────────────────────────────────────────

# Gefundene Probleme sammeln wir ein und geben sie am Ende gebündelt aus —
# jeweils mit dem Befehl, der als Nächstes hilft.
DOCTOR_FINDINGS=()

add_finding() {
  DOCTOR_FINDINGS+=("$1")
}

cmd_doctor() {
  require_docker_cli

  say ""
  say "${C_BOLD}Lokyy Brain — Diagnose${C_RESET} (nur lesend, es wird nichts verändert)"
  say ""

  # ── 1) Läuft der Docker-Daemon? ────────────────────────────────────────────
  step "1/5 — Docker-Daemon"
  require_docker_daemon
  ok "Docker-Daemon läuft: $(docker --version 2>/dev/null)"

  # ── 2) Compose-Plugin v2 vorhanden? ────────────────────────────────────────
  step "2/5 — Compose-Plugin (docker compose v2)"
  if ! docker compose version >/dev/null 2>&1; then
    fail "Der Unterbefehl \"docker compose\" ist nicht verfügbar."
    say "    Lokyy Brain braucht Compose v2 — also ${C_BOLD}docker compose${C_RESET} (mit Leerzeichen),"
    say "    nicht das alte ${C_BOLD}docker-compose${C_RESET} (mit Bindestrich)."
    say ""
    exit 3
  fi
  ok "Compose gefunden: $(docker compose version 2>/dev/null | head -n 1)"

  require_compose_file

  # ── 3) Speicherplatz — Dockers eigenen Bericht durchreichen ────────────────
  # Bewusst ohne eigene Schwellwerte: was "zu wenig" ist, hängt vom Rechner ab.
  # Die Zahlen von Docker sind aussagekräftiger als jede geratene Grenze.
  step "3/5 — Speicherplatz (Bericht von Docker)"
  say ""
  docker system df
  say ""
  say "    Zum Aufräumen (löscht ungenutzte Images/Cache):  ${C_BOLD}docker system prune${C_RESET}"
  say ""

  # Läuft unser Stack gerade? Das entscheidet darüber, ob ein belegter Port
  # normal ist (unsere eigenen Container) oder ein echter Konflikt.
  RUNNING_IDS="$(compose ps -q --status running 2>/dev/null)"
  STACK_RUNNING=0
  [ -n "${RUNNING_IDS}" ] && STACK_RUNNING=1

  # ── 4) Ports ───────────────────────────────────────────────────────────────
  step "4/5 — Ports (8787, 8095, 8788, 8790)"
  for entry in ${PORTS_TO_CHECK}; do
    port="${entry%%:*}"
    label="${entry#*:}"
    label="$(printf '%s' "${label}" | tr '-' ' ')"

    if is_port_in_use "${port}"; then
      if [ "${STACK_RUNNING}" -eq 1 ]; then
        ok "Port ${port} (${label}) ist belegt — vermutlich von Lokyy Brain selbst."
      else
        warn "Port ${port} (${label}) ist belegt, obwohl kein Lokyy-Container läuft."
        print_port_holder "${port}"
        add_finding "Port ${port} (${label}) ist von einem fremden Programm belegt.${NL}      Erst prüfen, wer das ist (siehe oben), dann:  docker compose -f ${COMPOSE_FILE} down --remove-orphans && ./lokyy.sh start"
      fi
    else
      ok "Port ${port} (${label}) ist frei."
    fi
  done

  # ── 5) Container ───────────────────────────────────────────────────────────
  step "5/5 — Container"
  say ""
  compose ps -a
  say ""

  # Für die Bewertung fragen wir dieselben Daten noch einmal maschinenlesbar ab.
  # Ältere Compose-Versionen kennen keine Go-Templates — dann verzichten wir
  # eben auf die automatische Bewertung, statt hier mit einem Fehler abzubrechen.
  CONTAINER_STATES="$(compose ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2>/dev/null)"

  if [ -z "${CONTAINER_STATES}" ]; then
    if [ "${STACK_RUNNING}" -eq 0 ]; then
      warn "Es läuft aktuell kein einziger Lokyy-Container."
      add_finding "Der Stack läuft nicht.${NL}      Starten mit:  ./lokyy.sh start"
    else
      warn "Die Container-Zustände konnten nicht ausgewertet werden (sehr alte Compose-Version?)."
      say "    Die Tabelle oben stimmt trotzdem — bitte selbst darüberschauen."
    fi
  else
    # Die Auswertung läuft bewusst NICHT in einer Pipe: eine while-Schleife
    # hinter einer Pipe landet in einer Subshell, und alles, was wir dort in
    # DOCTOR_FINDINGS schreiben, wäre danach wieder weg.
    while IFS='|' read -r svc state health; do
      [ -z "${svc}" ] && continue

      if [ "${svc}" = "${ONESHOT_SERVICE}" ] && [ "${state}" = "exited" ]; then
        ok "${svc}: einmalig gelaufen und beendet — genau so soll es sein."
        continue
      fi

      case "${state}" in
        running)
          case "${health}" in
            unhealthy)
              warn "${svc}: läuft, meldet sich aber als ${C_BOLD}unhealthy${C_RESET}."
              add_finding "${svc} ist unhealthy.${NL}      Logs ansehen:  docker compose -f ${COMPOSE_FILE} logs ${svc}"
              ;;
            starting)
              warn "${svc}: fährt noch hoch (Healthcheck läuft) — in einer Minute nochmal schauen."
              ;;
            *)
              ok "${svc}: läuft."
              ;;
          esac
          ;;
        restarting)
          warn "${svc}: startet immer wieder neu — das ist eine Absturz-Schleife."
          add_finding "${svc} hängt in einer Neustart-Schleife.${NL}      Logs ansehen:  docker compose -f ${COMPOSE_FILE} logs ${svc}"
          ;;
        exited|dead)
          warn "${svc}: ist beendet (Zustand: ${state})."
          add_finding "${svc} läuft nicht mehr.${NL}      Logs ansehen:  docker compose -f ${COMPOSE_FILE} logs ${svc}"
          ;;
        *)
          warn "${svc}: unbekannter Zustand \"${state}\"."
          add_finding "${svc} hat einen unerwarteten Zustand (${state}).${NL}      Logs ansehen:  docker compose -f ${COMPOSE_FILE} logs ${svc}"
          ;;
      esac
    done <<EOF
${CONTAINER_STATES}
EOF
  fi

  # ── Zusammenfassung ────────────────────────────────────────────────────────
  say ""
  step "Zusammenfassung"
  say ""

  if [ "${#DOCTOR_FINDINGS[@]}" -eq 0 ]; then
    say "  ${C_GREEN}${C_BOLD}Alles sieht gut aus.${C_RESET}"
    say ""
    exit 0
  fi

  say "  ${C_YELLOW}${C_BOLD}Diese Punkte sind aufgefallen:${C_RESET}"
  say ""
  for finding in "${DOCTOR_FINDINGS[@]}"; do
    printf '%s\n' "    • ${finding}"
  done
  say ""
  say "  doctor ändert von sich aus nichts — die Befehle oben führst du selbst aus."
  say ""
  exit 4
}

# ─────────────────────────────────────────────────────────────────────────────
# Befehl auswählen
# ─────────────────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)
    cmd_start
    ;;
  stop)
    cmd_stop
    ;;
  restart)
    cmd_restart
    ;;
  status)
    cmd_status
    ;;
  doctor)
    cmd_doctor
    ;;
  *)
    usage
    exit 1
    ;;
esac
