#!/usr/bin/env bash
# install.sh — Lokyy Brain lokal starten (macOS und Linux).
#
# Das ist der ERSTE Schritt nach dem Download. Du musst `docker compose` NICHT
# selbst aufrufen — das erledigt dieses Script für dich.
#
# Was passiert hier, der Reihe nach:
#   1. Betriebssystem erkennen (macOS oder Linux)
#   2. Prüfen, ob Docker installiert ist
#   3. Prüfen, ob der Docker-Daemon wirklich LÄUFT (nicht nur installiert ist)
#   4. Prüfen, ob "docker compose" (Version 2) verfügbar ist
#   5. Prüfen, ob die Ports frei sind, die Lokyy Brain braucht (nur Warnung)
#   6. Den Stack starten: docker compose -f docker-compose.local.yml up -d --build
#   7. Warten, bis die Web-UI erreichbar ist (erster Start baut Images = dauert)
#   8. Browser öffnen
#   9. Kurze Zusammenfassung "wie geht es weiter"
#
# Aufruf — beides funktioniert:
#   bash install.sh
#   ./install.sh          (falls das Ausführ-Recht gesetzt ist)
#
# Exit-Codes:
#   0  alles gut
#   1  Docker ist nicht installiert
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  der Stack konnte nicht gestartet werden

# -u  = Zugriff auf nicht gesetzte Variablen ist ein Fehler (fängt Tippfehler).
# -o pipefail = eine fehlgeschlagene Pipe-Stufe macht die ganze Pipe rot.
# Absichtlich KEIN -e: wir prüfen jeden Schritt selbst und wollen dabei immer
# eine verständliche deutsche Meldung ausgeben, statt still abzubrechen.
set -uo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Konfiguration — hier stehen alle Werte, die sich ändern könnten
# ─────────────────────────────────────────────────────────────────────────────

COMPOSE_FILE="docker-compose.local.yml"
PWA_URL="http://localhost:8095"
API_URL="http://localhost:8787"
MCP_URL="http://localhost:8788/mcp"
FORGEJO_URL="http://localhost:3001"

# Ports, die docker-compose.local.yml auf dem Host belegt.
# Format "Port:Beschriftung" — bewusst eine einfache Liste statt eines
# assoziativen Arrays, weil macOS noch mit bash 3.2 ausgeliefert wird und
# assoziative Arrays dort nicht existieren.
PORTS_TO_CHECK="8787:Server-API 8095:Web-UI-(PWA) 8788:MCP-Server 3001:Forgejo-Web-UI 2222:Forgejo-SSH"

# Wie lange warten wir maximal, bis die Web-UI antwortet?
MAX_WAIT_SECONDS=90
POLL_INTERVAL_SECONDS=2

# Doku-Links (OS-spezifisch), falls Docker fehlt
DOCS_MAC="https://docs.docker.com/desktop/setup/install/mac-install/"
DOCS_LINUX="https://docs.docker.com/engine/install/"
DOCS_WINDOWS="https://docs.docker.com/desktop/setup/install/windows-install/"

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

say ""
say "${C_BOLD}Lokyy Brain — lokale Installation${C_RESET}"
say "Projekt-Ordner: ${SCRIPT_DIR}"
say ""

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 1 — Betriebssystem erkennen
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 1/9 — Betriebssystem erkennen"

OS_KERNEL="$(uname -s 2>/dev/null || echo unknown)"
case "${OS_KERNEL}" in
  Darwin)
    OS_NAME="macOS"
    DOCS_URL="${DOCS_MAC}"
    ;;
  Linux)
    OS_NAME="Linux"
    DOCS_URL="${DOCS_LINUX}"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash / MSYS unter Windows. Läuft grundsätzlich, aber install.ps1 ist
    # dort der bessere Weg (echtes PowerShell, öffnet den Browser zuverlässig).
    OS_NAME="Windows (Git Bash)"
    DOCS_URL="${DOCS_WINDOWS}"
    warn "Unter Windows ist install.ps1 der empfohlene Weg (PowerShell: .\\install.ps1)."
    ;;
  *)
    OS_NAME="Unbekannt (${OS_KERNEL})"
    DOCS_URL="${DOCS_LINUX}"
    warn "Unbekanntes System — wir versuchen es trotzdem."
    ;;
esac

ok "System erkannt: ${OS_NAME}"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 2 — Ist Docker überhaupt installiert?
# Wir installieren Docker BEWUSST nicht selbst: das braucht Admin-Rechte,
# teils einen Neustart und läuft auf jedem Rechner anders. Das machst du einmal
# von Hand, danach funktioniert dieses Script.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 2/9 — Docker-Installation prüfen"

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker ist auf diesem Rechner nicht installiert."
  say ""
  say "  Lokyy Brain läuft komplett in Docker-Containern — ohne Docker geht nichts."
  say "  Bitte installiere Docker einmalig und starte dieses Script danach erneut:"
  say ""
  say "      ${C_BOLD}${DOCS_URL}${C_RESET}"
  if [ "${OS_KERNEL}" = "Darwin" ]; then
    say ""
    say "  (Auf dem Mac ist das \"Docker Desktop\" — herunterladen, in den"
    say "   Programme-Ordner ziehen, einmal starten.)"
  elif [ "${OS_KERNEL}" = "Linux" ]; then
    say ""
    say "  (Unter Linux ist das die \"Docker Engine\" inklusive Compose-Plugin.)"
  fi
  say ""
  exit 1
fi

ok "Docker gefunden: $(docker --version 2>/dev/null)"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 3 — Läuft der Docker-Daemon wirklich?
# Das ist der mit Abstand häufigste Stolperstein: Docker Desktop ist zwar
# installiert, aber nach dem Rechnerstart nie geöffnet worden. Der Befehl
# "docker" existiert dann — nur antwortet niemand dahinter.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 3/9 — Docker-Daemon prüfen (läuft Docker gerade?)"

if ! docker info >/dev/null 2>&1; then
  fail "Docker ist installiert, aber der Docker-Daemon antwortet nicht."
  say ""
  if [ "${OS_KERNEL}" = "Darwin" ]; then
    say "  Bitte starte ${C_BOLD}Docker Desktop${C_RESET} (Programme-Ordner oder Spotlight)"
    say "  und warte, bis das Wal-Symbol in der Menüleiste ruhig steht / \"running\" meldet."
  elif [ "${OS_KERNEL}" = "Linux" ]; then
    say "  Bitte starte den Docker-Dienst:"
    say ""
    say "      ${C_BOLD}sudo systemctl start docker${C_RESET}"
    say ""
    say "  Falls stattdessen eine Rechte-Meldung kommt (\"permission denied\"),"
    say "  fehlt dein Benutzer in der docker-Gruppe:"
    say ""
    say "      ${C_BOLD}sudo usermod -aG docker \$USER${C_RESET}   (danach neu anmelden)"
  else
    say "  Bitte starte Docker Desktop und warte, bis es \"running\" meldet."
  fi
  say ""
  say "  Danach dieses Script einfach noch einmal aufrufen."
  say ""
  exit 2
fi

ok "Docker-Daemon läuft."

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 4 — "docker compose" (v2) verfügbar?
# Achtung: gemeint ist der Unterbefehl "docker compose" (mit Leerzeichen),
# nicht das alte eigenständige Programm "docker-compose" (mit Bindestrich).
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 4/9 — Compose-Plugin prüfen (docker compose v2)"

if ! docker compose version >/dev/null 2>&1; then
  fail "Der Unterbefehl \"docker compose\" ist nicht verfügbar."
  say ""
  say "  Lokyy Brain braucht Compose v2 — also ${C_BOLD}docker compose${C_RESET} (mit Leerzeichen),"
  say "  nicht das alte ${C_BOLD}docker-compose${C_RESET} (mit Bindestrich)."
  say ""
  say "  In Docker Desktop ist Compose v2 immer enthalten; unter Linux muss das"
  say "  Paket \"docker-compose-plugin\" mitinstalliert sein. Anleitung:"
  say ""
  say "      ${C_BOLD}${DOCS_URL}${C_RESET}"
  say ""
  exit 3
fi

ok "Compose gefunden: $(docker compose version 2>/dev/null | head -n 1)"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 5 — Sind die benötigten Ports frei?
# Das ist NUR eine freundliche Vorwarnung. Wir brechen hier absichtlich nicht
# ab: vielleicht läuft dort schon ein früherer Lokyy-Brain-Start. Wenn wirklich
# ein Konflikt besteht, meldet Docker Compose das gleich selbst — nur eben in
# einer Sprache, die man erst mal übersetzen muss.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 5/9 — Ports prüfen (8787, 8095, 8788, 3001, 2222)"

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

PORTS_BUSY=0
for entry in ${PORTS_TO_CHECK}; do
  port="${entry%%:*}"      # alles vor dem ersten ":"
  label="${entry#*:}"      # alles nach dem ersten ":"
  label="$(printf '%s' "${label}" | tr '-' ' ')"

  if is_port_in_use "${port}"; then
    warn "Port ${C_BOLD}${port}${C_RESET} (${label}) ist bereits belegt — dort läuft schon etwas anderes."
    PORTS_BUSY=$((PORTS_BUSY + 1))
  fi
done

if [ "${PORTS_BUSY}" -gt 0 ]; then
  say ""
  say "    Das ist ${C_BOLD}kein Abbruchgrund${C_RESET} — es kann auch ein früherer Lokyy-Brain-Start sein."
  say "    Wenn es wirklich kollidiert, sagt Docker Compose gleich selbst Bescheid."
  say "    Tipp: alte Container stoppen mit"
  say "        ${C_BOLD}docker compose -f ${COMPOSE_FILE} down${C_RESET}"
  say ""
else
  ok "Alle benötigten Ports sind frei."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 6 — Den Stack starten
# Beim allerersten Mal werden hier Images gebaut und heruntergeladen.
# Das dauert je nach Internetverbindung durchaus ein paar Minuten.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 6/9 — Lokyy Brain starten (beim ersten Mal dauert das ein paar Minuten)"

if [ ! -f "${COMPOSE_FILE}" ]; then
  fail "Die Datei ${COMPOSE_FILE} liegt nicht im Projekt-Ordner."
  say "    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde."
  exit 4
fi

say ""
docker compose -f "${COMPOSE_FILE}" up -d --build
COMPOSE_EXIT=$?
say ""

if [ "${COMPOSE_EXIT}" -ne 0 ]; then
  fail "Der Start ist fehlgeschlagen (docker compose Exit-Code ${COMPOSE_EXIT})."
  say ""
  say "    Die Fehlermeldung von Docker steht direkt darüber. Häufige Ursachen:"
  say "      • Ein Port ist wirklich belegt (siehe Warnungen oben)"
  say "      • Kein Speicherplatz mehr — aufräumen mit ${C_BOLD}docker system prune${C_RESET}"
  say "      • Keine Internetverbindung zum Herunterladen der Images"
  say ""
  say "    Logs ansehen:  ${C_BOLD}docker compose -f ${COMPOSE_FILE} logs${C_RESET}"
  say ""
  exit 4
fi

ok "Container gestartet."

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 7 — Warten, bis die Web-UI antwortet
# "Container gestartet" heißt noch nicht "Anwendung bereit": der Server muss
# erst hochfahren, die Datenbank migrieren usw. Deshalb fragen wir alle paar
# Sekunden nach, ob die Seite schon antwortet. Jeder Punkt = ein Versuch.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 7/9 — Warten, bis die Web-UI erreichbar ist (max. ${MAX_WAIT_SECONDS} Sekunden)"

# Rückgabe: 0 = die Seite antwortet, 1 = noch nicht.
# Uns interessiert NUR, ob eine Verbindung zustande kommt — welcher HTTP-Status
# zurückkommt, ist an dieser Stelle egal.
is_pwa_reachable() {
  if command -v curl >/dev/null 2>&1; then
    curl --silent --output /dev/null --max-time 3 "${PWA_URL}" >/dev/null 2>&1
    return $?
  fi

  # Fallback ohne curl: reiner TCP-Verbindungstest über bash.
  if (exec 3<>/dev/tcp/localhost/8095) >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

PWA_READY=0
ATTEMPTS=$((MAX_WAIT_SECONDS / POLL_INTERVAL_SECONDS))
printf '    '

i=1
while [ "${i}" -le "${ATTEMPTS}" ]; do
  if is_pwa_reachable; then
    PWA_READY=1
    break
  fi
  printf '.'
  sleep "${POLL_INTERVAL_SECONDS}"
  i=$((i + 1))
done
printf '\n'

if [ "${PWA_READY}" -eq 1 ]; then
  ok "Web-UI antwortet unter ${PWA_URL}"
else
  warn "Die Web-UI hat nach ${MAX_WAIT_SECONDS} Sekunden noch nicht geantwortet."
  say "    Das ist beim allerersten Start normal (Images bauen dauert)."
  say "    Wir öffnen den Browser trotzdem — lade die Seite in ein bis zwei"
  say "    Minuten einfach neu."
  say "    Status ansehen:  ${C_BOLD}docker compose -f ${COMPOSE_FILE} ps${C_RESET}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 8 — Browser öffnen
# macOS kennt "open", die meisten Linux-Desktops "xdg-open". Gibt es beides
# nicht (z. B. auf einem Server ohne Oberfläche), geben wir nur die URL aus.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 8/9 — Browser öffnen"

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

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 9 — Wie geht es weiter?
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 9/9 — Fertig"

say ""
say "${C_GREEN}${C_BOLD}Lokyy Brain läuft.${C_RESET}"
say ""
say "  ${C_BOLD}Web-UI (hier geht es los)${C_RESET}   ${PWA_URL}"
say "  Server-API                  ${API_URL}"
say "  MCP-Endpoint                ${MCP_URL}"
say "  Forgejo (optional)          ${FORGEJO_URL}"
say ""
say "${C_BOLD}Nächster Schritt${C_RESET}"
say "  Im Browser startet automatisch der Setup-Wizard und führt dich durch"
say "  den Rest — Admin-Account, Vault, Datenbank, Embeddings."
say "  Bei der Forgejo-Frage kannst du getrost"
say "  ${C_BOLD}\"Ohne Forgejo fortfahren (nur lokal)\"${C_RESET} wählen: dann läuft alles"
say "  rein lokal, ohne externen Git-Server. Nachrüsten geht jederzeit."
say ""
say "${C_BOLD}KI-Agenten anbinden (MCP)${C_RESET}"
say "  Endpoint:  ${MCP_URL}"
say "  Auth:      Bearer-Token = der Wert von ${C_BOLD}LOKYY_MCP_TOKEN${C_RESET} in ${COMPOSE_FILE}"
say "             (Standard ist nur ein Platzhalter zum Testen —"
say "             für den echten Einsatz bitte ändern.)"
say ""
say "${C_BOLD}Nützliche Befehle${C_RESET}"
say "  Status:    docker compose -f ${COMPOSE_FILE} ps"
say "  Logs:      docker compose -f ${COMPOSE_FILE} logs -f"
say "  Stoppen:   docker compose -f ${COMPOSE_FILE} down"
say ""

exit 0
