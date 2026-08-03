#!/usr/bin/env bash
# install.sh — Lokyy Brain lokal starten (macOS und Linux).
#
# Das ist der ERSTE Schritt nach dem Download. Du musst `docker compose` NICHT
# selbst aufrufen — das erledigt dieses Script für dich.
#
# Was passiert hier, der Reihe nach:
#   1. Betriebssystem erkennen (macOS oder Linux)
#   2. Prüfen, ob Docker installiert ist — und es bei Bedarf automatisch
#      installieren (Linux: offizielles get.docker.com-Script per sudo,
#      macOS: Homebrew-Cask). Wo das nicht sicher automatisierbar ist
#      (macOS ohne Homebrew, unbekanntes System), bleibt es beim Link.
#   3. Prüfen, ob der Docker-Daemon wirklich LÄUFT (nicht nur installiert ist)
#   4. Prüfen, ob "docker compose" (Version 2) verfügbar ist
#   5. Prüfen, ob die Ports frei sind, die Lokyy Brain braucht (nur Warnung)
#   6. Den Stack starten: docker compose -f docker-compose.local.yml up -d --build
#      (hängt noch ein Port-Rest aus einem früheren Lauf, wird EINMAL automatisch
#       aufgeräumt und neu gestartet; sonst folgt eine Diagnose, wer den Port hält)
#   7. Warten, bis Web-UI UND API bereit sind (erster Start baut Images = dauert;
#      die Web-UI allein antwortet schon, während der Server noch hochfährt)
#   8. Browser öffnen
#   9. Kurze Zusammenfassung "wie geht es weiter"
#
# Aufruf — beides funktioniert:
#   bash install.sh
#   ./install.sh          (falls das Ausführ-Recht gesetzt ist)
#
# Exit-Codes:
#   0  alles gut
#   1  Docker fehlt und konnte nicht automatisch installiert werden
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  der Stack konnte nicht gestartet werden
#   5  Docker installiert, aber ein Neustart ist nötig (nur install.ps1 unter
#      Windows/WSL2 — dieses Script gibt 5 nie zurück)

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
FORGEJO_URL="http://localhost:8790"

# Ports, die docker-compose.local.yml auf dem Host belegt.
# Format "Port:Beschriftung" — bewusst eine einfache Liste statt eines
# assoziativen Arrays, weil macOS noch mit bash 3.2 ausgeliefert wird und
# assoziative Arrays dort nicht existieren.
PORTS_TO_CHECK="8787:Server-API 8095:Web-UI-(PWA) 8788:MCP-Server 8790:Forgejo-Web-UI"

# Wie lange warten wir maximal, bis Web-UI und API antworten?
MAX_WAIT_SECONDS=90
POLL_INTERVAL_SECONDS=2

# Wie lange warten wir maximal, bis Docker Desktop nach einer frischen
# Installation (macOS) hochgefahren ist?
DOCKER_START_WAIT_SECONDS=60

# Wird in Schritt 2 auf "sudo" gesetzt, falls Docker gerade erst installiert
# wurde und die neue docker-Gruppe in DIESER Shell noch nicht greift.
# Normalfall: leer — dann verschwindet die Variable bei der Expansion einfach.
DOCKER_SUDO=""

# Wie lange warten wir maximal auf die Xcode Command Line Tools (macOS)?
# Die installiert macOS in einem eigenen Fenster — das kann dauern.
XCODE_CLT_WAIT_SECONDS=600
XCODE_POLL_SECONDS=5

# Ablageorte für die offiziellen Installations-Scripte (Schritt 2).
DOCKER_INSTALL_SCRIPT="/tmp/lokyy-get-docker.sh"
BREW_INSTALL_SCRIPT="/tmp/lokyy-install-homebrew.sh"

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

# Absoluter Pfad auf dieses Script plus die übergebenen Argumente.
# Beides brauchen wir nur an einer Stelle: wenn wir uns unter Linux nach der
# Docker-Installation über "sg docker" selbst neu starten (siehe Schritt 2).
# Absichtlich absolut — nach dem cd oben wäre "$0" sonst womöglich relativ zum
# ursprünglichen Arbeitsverzeichnis und ins Leere gelaufen.
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"
SCRIPT_ARGS=""
if [ "$#" -gt 0 ]; then
  for _arg in "$@"; do
    SCRIPT_ARGS="${SCRIPT_ARGS} '${_arg}'"
  done
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
# Fehlt Docker, versuchen wir es SELBST zu installieren — mit dem jeweils
# offiziellen Weg des Systems (Linux: get.docker.com, macOS: Homebrew-Cask).
# Automatisch geht das aber nur so weit, wie das Betriebssystem es zulässt:
# Passwort-Abfragen und System-Dialoge muss der Mensch bedienen. Wo gar nichts
# Verlässliches möglich ist, bleibt es bei der Anleitung zum Selbermachen.
# ─────────────────────────────────────────────────────────────────────────────

# Der klassische "mach es bitte von Hand"-Hinweis. Wird von allen
# Fehlerpfaden unten wiederverwendet, damit die Meldung überall gleich ist.
docker_manual_hint() {
  say ""
  say "  Lokyy Brain läuft komplett in Docker-Containern — ohne Docker geht nichts."
  say "  Bitte installiere Docker einmalig von Hand und starte dieses Script danach erneut:"
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
}

# Wartet, bis der Docker-Daemon antwortet. Jeder Punkt = ein Versuch.
# Rückgabe: 0 = Daemon antwortet, 1 = Zeit abgelaufen.
wait_for_docker_daemon() {
  local waited
  waited=0
  printf '    '
  while [ "${waited}" -lt "${DOCKER_START_WAIT_SECONDS}" ]; do
    if ${DOCKER_SUDO} docker info >/dev/null 2>&1; then
      printf '\n'
      return 0
    fi
    printf '.'
    sleep "${POLL_INTERVAL_SECONDS}"
    waited=$((waited + POLL_INTERVAL_SECONDS))
  done
  printf '\n'
  return 1
}

# ── Linux: Docker Engine über das offizielle Script von Docker installieren ──
install_docker_linux() {
  # Zweiter Durchlauf nach dem sg-Neustart (siehe unten) und Docker fehlt
  # IMMER noch? Dann NICHT erneut installieren — sonst dreht sich das Script
  # im Kreis. Lieber ehrlich abbrechen.
  if [ -n "${LOKYY_DOCKER_INSTALL_ATTEMPTED:-}" ]; then
    fail "Docker wurde installiert, ist in dieser Shell aber weiterhin nicht auffindbar."
    say "    Bitte melde dich einmal ab und wieder an und starte dieses Script erneut."
    docker_manual_hint
    exit 1
  fi

  say ""
  say "  Wir installieren Docker jetzt automatisch — mit dem offiziellen"
  say "  Installations-Script von Docker (${C_BOLD}https://get.docker.com${C_RESET})."
  say "  Dafür sind Administrator-Rechte nötig: gleich fragt ${C_BOLD}sudo${C_RESET} nach deinem"
  say "  Passwort. Das ist normal — beim Tippen bleibt die Zeile sichtbar leer."
  say ""

  if ! command -v curl >/dev/null 2>&1; then
    fail "Für die automatische Installation wird curl gebraucht — es fehlt auf diesem System."
    docker_manual_hint
    exit 1
  fi

  if ! curl -fsSL https://get.docker.com -o "${DOCKER_INSTALL_SCRIPT}"; then
    fail "Das Installations-Script konnte nicht heruntergeladen werden (Internetverbindung?)."
    docker_manual_hint
    exit 1
  fi

  if ! sudo sh "${DOCKER_INSTALL_SCRIPT}"; then
    fail "Die automatische Docker-Installation ist fehlgeschlagen."
    say "    Die Meldung des Installers steht direkt darüber."
    docker_manual_hint
    exit 1
  fi

  rm -f "${DOCKER_INSTALL_SCRIPT}"
  # bash merkt sich gefundene Programme — nach einer frischen Installation
  # muss dieser Merkzettel geleert werden, sonst "gibt es" docker noch nicht.
  hash -r 2>/dev/null || true

  if ! command -v docker >/dev/null 2>&1; then
    fail "Der Installer lief durch, trotzdem ist docker nicht auffindbar."
    docker_manual_hint
    exit 1
  fi

  ok "Docker wurde installiert: $(docker --version 2>/dev/null)"

  # Ohne Mitgliedschaft in der Gruppe "docker" bräuchte jeder docker-Aufruf
  # ein sudo davor. Also: Benutzer eintragen.
  CURRENT_USER="${USER:-$(id -un)}"
  if ! sudo usermod -aG docker "${CURRENT_USER}"; then
    warn "Konnte ${CURRENT_USER} nicht zur Gruppe \"docker\" hinzufügen."
    warn "Wir arbeiten in diesem Durchlauf ersatzweise mit sudo weiter."
    DOCKER_SUDO="sudo"
    return 0
  fi
  ok "Benutzer ${CURRENT_USER} zur Gruppe \"docker\" hinzugefügt."

  # Der Haken: die neue Gruppe gilt erst für NEU gestartete Prozesse — diese
  # Shell hier kennt sie noch nicht. "sg docker -c ..." startet eine Shell
  # MIT der Gruppe, also starten wir uns darin einfach selbst neu. Beim
  # zweiten Durchlauf findet Schritt 2 dann ein funktionierendes docker vor
  # und läuft ganz normal weiter zu Schritt 3.
  export LOKYY_DOCKER_INSTALL_ATTEMPTED=1

  if command -v sg >/dev/null 2>&1; then
    say ""
    say "  Damit die neue Gruppe sofort greift, starten wir dieses Script einmal neu."
    say ""
    exec sg docker -c "bash '${SCRIPT_PATH}'${SCRIPT_ARGS}"
  fi

  # Kein sg vorhanden: für DIESEN Durchlauf mit sudo weiterarbeiten.
  DOCKER_SUDO="sudo"
  say ""
  warn "Für diesen Durchlauf rufen wir docker mit sudo auf."
  say "    Damit du künftig ohne sudo arbeiten kannst, melde dich einmal ab und"
  say "    wieder an — oder öffne ein neues Terminal und rufe dort einmal"
  say "    ${C_BOLD}newgrp docker${C_RESET} auf."
  say ""
}

# ── macOS: Homebrew nachinstallieren (Voraussetzung für Docker Desktop) ──
install_homebrew_macos() {
  say ""
  say "  Für die automatische Installation brauchen wir ${C_BOLD}Homebrew${C_RESET} — den"
  say "  Paketmanager für macOS. Den installieren wir zuerst, danach Docker."
  say "  Der offizielle Homebrew-Installer fragt dabei über sudo nach deinem"
  say "  Mac-Passwort. Das ist normal."
  say ""

  if ! command -v curl >/dev/null 2>&1; then
    fail "Für die automatische Installation wird curl gebraucht — es fehlt auf diesem System."
    docker_manual_hint
    exit 1
  fi

  # Homebrew setzt die Xcode Command Line Tools voraus. Fehlen sie, öffnet
  # macOS ein eigenes Fenster zum Installieren. Dieses Fenster kann ein
  # Script NICHT bedienen — das ist eine Sicherheitsgrenze von macOS, kein
  # Fehler. Wir sagen ehrlich Bescheid und warten dann darauf.
  if ! xcode-select -p >/dev/null 2>&1; then
    say "  Es fehlen noch die ${C_BOLD}Xcode Command Line Tools${C_RESET}."
    say "  macOS öffnet dafür gleich ein eigenes Fenster — bitte dort auf"
    say "  ${C_BOLD}\"Installieren\"${C_RESET} klicken. Dieses Fenster kann dir ein Script nicht"
    say "  abnehmen (so ist macOS gebaut). Wir warten hier so lange."
    say ""
    xcode-select --install >/dev/null 2>&1 || true

    xcode_waited=0
    printf '    '
    while [ "${xcode_waited}" -lt "${XCODE_CLT_WAIT_SECONDS}" ]; do
      if xcode-select -p >/dev/null 2>&1; then
        break
      fi
      printf '.'
      sleep "${XCODE_POLL_SECONDS}"
      xcode_waited=$((xcode_waited + XCODE_POLL_SECONDS))
    done
    printf '\n'

    if ! xcode-select -p >/dev/null 2>&1; then
      fail "Die Xcode Command Line Tools sind noch nicht fertig installiert."
      say "    Bitte warte, bis das macOS-Fenster fertig ist, und führe dieses"
      say "    Script danach einfach erneut aus."
      say ""
      exit 1
    fi
    ok "Xcode Command Line Tools sind da."
  fi

  # Bewusst erst herunterladen, dann ausführen: bei der verbreiteten
  # Kurzform  /bin/bash -c "$(curl …)"  bliebe ein fehlgeschlagener Download
  # unbemerkt — bash würde einfach eine leere Zeichenkette ausführen und 0
  # zurückgeben. So sehen wir jeden Fehlschlag einzeln.
  if ! curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh -o "${BREW_INSTALL_SCRIPT}"; then
    fail "Der Homebrew-Installer konnte nicht heruntergeladen werden (Internetverbindung?)."
    docker_manual_hint
    exit 1
  fi

  if ! NONINTERACTIVE=1 /bin/bash "${BREW_INSTALL_SCRIPT}"; then
    fail "Die automatische Homebrew-Installation ist fehlgeschlagen."
    say "    Die Meldung des Installers steht direkt darüber."
    docker_manual_hint
    exit 1
  fi

  rm -f "${BREW_INSTALL_SCRIPT}"

  # Frisch installiertes Homebrew liegt je nach Mac woanders und ist in
  # DIESER Shell noch nicht im PATH: Apple Silicon /opt/homebrew,
  # Intel /usr/local. Wir holen es aktiv dazu, damit der nächste Schritt
  # nicht an einem fehlenden "brew" scheitert.
  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "${brew_bin}" ]; then
      eval "$("${brew_bin}" shellenv)"
      break
    fi
  done
  hash -r 2>/dev/null || true

  if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew wurde installiert, ist in dieser Shell aber nicht auffindbar."
    say "    Bitte öffne ein neues Terminal und führe dieses Script dort erneut aus."
    say ""
    exit 1
  fi

  ok "Homebrew installiert: $(brew --version 2>/dev/null | head -n 1)"
}

# ── macOS: Docker Desktop über Homebrew installieren und starten ──
install_docker_macos() {
  if ! command -v brew >/dev/null 2>&1; then
    install_homebrew_macos
  fi

  say ""
  say "  Docker Desktop wird jetzt über Homebrew installiert."
  say "  Das lädt ein großes Paket — je nach Leitung dauert das ein paar Minuten."
  say ""

  if ! brew install --cask docker; then
    fail "Die automatische Installation von Docker Desktop ist fehlgeschlagen."
    say "    Die Meldung von Homebrew steht direkt darüber."
    docker_manual_hint
    exit 1
  fi

  ok "Docker Desktop wurde installiert."

  say ""
  say "  Wir starten Docker Desktop jetzt."
  say ""
  say "  ${C_BOLD}Wichtig:${C_RESET} Beim allerersten Start zeigt macOS in der Regel ein"
  say "  Systemfenster und fragt nach deinem Mac-Passwort (Docker richtet dabei"
  say "  einen Hilfsdienst ein). Bitte dort auf ${C_BOLD}\"OK\"${C_RESET} klicken bzw. das"
  say "  Passwort eingeben. Ein Script kann diesen Dialog nicht für dich"
  say "  wegklicken — das ist eine Sicherheitsgrenze von macOS, kein Fehler."
  say ""

  open -a Docker >/dev/null 2>&1 || warn "Docker Desktop konnte nicht automatisch gestartet werden."

  say "  Warten, bis Docker bereit ist (max. ${DOCKER_START_WAIT_SECONDS} Sekunden):"
  if ! wait_for_docker_daemon; then
    warn "Docker Desktop ist noch nicht bereit."
    say "    Bitte starte Docker Desktop einmal manuell (Programme-Ordner oder"
    say "    Spotlight), warte auf \"Engine running\" — und führe dieses Script"
    say "    danach erneut aus."
    say ""
    exit 1
  fi

  hash -r 2>/dev/null || true

  if ! command -v docker >/dev/null 2>&1; then
    fail "Docker Desktop läuft, der Befehl docker ist hier aber nicht auffindbar."
    say "    Bitte öffne ein neues Terminal und führe dieses Script dort erneut aus."
    say ""
    exit 1
  fi

  ok "Docker Desktop läuft."
}

step "Schritt 2/9 — Docker-Installation prüfen"

if ! command -v docker >/dev/null 2>&1; then
  warn "Docker ist auf diesem Rechner nicht installiert."

  case "${OS_KERNEL}" in
    Linux)
      install_docker_linux
      ;;
    Darwin)
      install_docker_macos
      ;;
    *)
      # Git Bash unter Windows und alles Unbekannte: hier gibt es keinen
      # verlässlichen automatischen Weg. Unter Windows macht das install.ps1.
      fail "Für dieses System gibt es hier keine automatische Installation."
      if [ "${OS_KERNEL}" != "${OS_KERNEL#MINGW}" ] || [ "${OS_KERNEL}" != "${OS_KERNEL#MSYS}" ] || [ "${OS_KERNEL}" != "${OS_KERNEL#CYGWIN}" ]; then
        say "    Unter Windows bitte PowerShell benutzen:  .\\install.ps1"
        say "    Das Script installiert Docker Desktop dort automatisch."
      fi
      docker_manual_hint
      exit 1
      ;;
  esac
fi

ok "Docker gefunden: $(${DOCKER_SUDO} docker --version 2>/dev/null)"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 3 — Läuft der Docker-Daemon wirklich?
# Das ist der mit Abstand häufigste Stolperstein: Docker Desktop ist zwar
# installiert, aber nach dem Rechnerstart nie geöffnet worden. Der Befehl
# "docker" existiert dann — nur antwortet niemand dahinter.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 3/9 — Docker-Daemon prüfen (läuft Docker gerade?)"

if ! ${DOCKER_SUDO} docker info >/dev/null 2>&1; then
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

if ! ${DOCKER_SUDO} docker compose version >/dev/null 2>&1; then
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

ok "Compose gefunden: $(${DOCKER_SUDO} docker compose version 2>/dev/null | head -n 1)"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 5 — Sind die benötigten Ports frei?
# Das ist NUR eine freundliche Vorwarnung. Wir brechen hier absichtlich nicht
# ab: vielleicht läuft dort schon ein früherer Lokyy-Brain-Start. Wenn wirklich
# ein Konflikt besteht, meldet Docker Compose das gleich selbst — nur eben in
# einer Sprache, die man erst mal übersetzen muss.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 5/9 — Ports prüfen (8787, 8095, 8788, 8790)"

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
#
# Bekannter Docker-Stolperstein beim ZWEITEN Lauf: aus einem früheren, evtl.
# abgebrochenen "up" hängt noch ein Container-Rest am Port ("port is already
# allocated"). Genau diesen Fall räumen wir automatisch auf (down) und starten
# danach GENAU EINMAL neu. Alle anderen Fehler (kein Platz, kein Internet,
# Build kaputt) werden NICHT wiederholt — das würde nur Zeit kosten.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 6/9 — Lokyy Brain starten (beim ersten Mal dauert das ein paar Minuten)"

if [ ! -f "${COMPOSE_FILE}" ]; then
  fail "Die Datei ${COMPOSE_FILE} liegt nicht im Projekt-Ordner."
  say "    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde."
  exit 4
fi

# Wir brauchen die Ausgabe von Compose zweimal: live auf dem Bildschirm (der
# Build läuft minutenlang — ohne Ausgabe sieht das aus wie ein Absturz) UND als
# Datei, um sie im Fehlerfall auswerten zu können. Beides zugleich = tee.
# Kein Suffix nach den X-en: das mag das mktemp von macOS/BSD nicht.
COMPOSE_LOG="$(mktemp "${TMPDIR:-/tmp}/lokyy-compose-XXXXXX" 2>/dev/null)"
if [ -z "${COMPOSE_LOG}" ]; then
  COMPOSE_LOG="/tmp/lokyy-compose-$$"
fi

# Startet den Stack und legt die Ausgabe in ${COMPOSE_LOG} ab.
# Rückgabe: der Exit-Code von docker compose — NICHT der von tee. Genau dafür
# ist PIPESTATUS da (bash-Erweiterung; dieses Script läuft per Shebang in bash).
compose_up() {
  ${DOCKER_SUDO} docker compose -f "${COMPOSE_FILE}" up -d --build 2>&1 | tee "${COMPOSE_LOG}"
  return "${PIPESTATUS[0]}"
}

say ""
compose_up
COMPOSE_EXIT=$?
say ""

# Zwei bekannte, selbstheilbare Fehlerbilder. Alles andere (kein Internet,
# kein Speicherplatz, ein echter Build-Fehler) wird NICHT wiederholt — das
# würde nur einen mehrminütigen Build umsonst kosten.
if [ "${COMPOSE_EXIT}" -ne 0 ] && grep -q "port is already allocated" "${COMPOSE_LOG}" 2>/dev/null; then
  warn "Ein Port ist noch belegt — das sieht nach einem Rest aus einem früheren Start aus."
  say "    Wir räumen den alten Stack automatisch ab und versuchen es genau einmal erneut."
  say ""
  ${DOCKER_SUDO} docker compose -f "${COMPOSE_FILE}" down --remove-orphans >/dev/null 2>&1

  # "down" kehrt zurück, sobald Docker die Container entfernt hat — der
  # dazugehörige docker-proxy-Prozess gibt den Host-Port dabei aber nicht
  # IMMER synchron frei. Ein sofortiger Retry kann deshalb genau denselben
  # "port is already allocated"-Fehler nochmal auslösen, obwohl in Wahrheit
  # nur unser eigener alter Prozess noch beim Aufräumen ist. Deshalb hier
  # aktiv warten, bis alle benötigten Ports laut TCP-Check wirklich frei sind
  # (max. 10 Sekunden) — statt blind sofort neu zu versuchen.
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
  # durcheinander (meist nach vielen Builds hintereinander oder einem
  # abgebrochenen vorherigen Build). "docker builder prune" räumt nur den
  # Cache auf — Container, Volumes und der Vault bleiben unangetastet.
  warn "Der Docker-Build-Cache scheint durcheinander zu sein (bekannter BuildKit-Aussetzer)."
  say "    Wir räumen den Cache automatisch auf und versuchen es genau einmal erneut."
  say "    Der nächste Build lädt dadurch ein paar Layer neu — das dauert etwas länger."
  say ""
  ${DOCKER_SUDO} docker builder prune -f >/dev/null 2>&1
  compose_up
  COMPOSE_EXIT=$?
  say ""
fi

if [ "${COMPOSE_EXIT}" -ne 0 ]; then
  fail "Der Start ist fehlgeschlagen (docker compose Exit-Code ${COMPOSE_EXIT})."
  say ""

  # Steht in der Meldung ein konkreter Port? Dann sagen wir dem Menschen auch
  # gleich, WER ihn hält — statt ihn selbst auf die Suche zu schicken.
  CONFLICT_PORT="$(grep -oE '0\.0\.0\.0:[0-9]+|Bind for [^ ]*:[0-9]+' "${COMPOSE_LOG}" 2>/dev/null | grep -oE '[0-9]+$' | head -n 1)"

  if [ -n "${CONFLICT_PORT}" ]; then
    # Bewusst OHNE sudo: eine unerwartete Passwort-Abfrage mitten in einer
    # Fehlermeldung ist die schlechtere Erfahrung. Ohne Root-Rechte bleibt die
    # Prozess-Spalte womöglich leer — die Belegung sieht man trotzdem.
    PORT_HOLDER=""
    if command -v ss >/dev/null 2>&1; then
      PORT_HOLDER="$(ss -tulpn 2>/dev/null | grep ":${CONFLICT_PORT} ")"
    fi
    if [ -z "${PORT_HOLDER}" ] && command -v lsof >/dev/null 2>&1; then
      PORT_HOLDER="$(lsof -i ":${CONFLICT_PORT}" 2>/dev/null)"
    fi
    if [ -z "${PORT_HOLDER}" ]; then
      # Vielleicht hält ein ganz anderes Docker-Projekt den Port.
      PORT_HOLDER="$(${DOCKER_SUDO} docker ps --filter "publish=${CONFLICT_PORT}" --format '{{.Names}}  ({{.Image}})' 2>/dev/null)"
    fi

    say "    Port ${C_BOLD}${CONFLICT_PORT}${C_RESET} ist belegt — auch nach dem automatischen Aufräumen."
    if [ -n "${PORT_HOLDER}" ]; then
      say ""
      say "    Belegt von:"
      printf '%s\n' "${PORT_HOLDER}" | while IFS= read -r holder_line; do
        say "      ${holder_line}"
      done
      say ""
      say "    Bitte dieses Programm beenden (oder in ${COMPOSE_FILE} einen anderen"
      say "    Port eintragen) und dieses Script erneut aufrufen."
    else
      say "    Wer den Port hält, war ohne Administrator-Rechte nicht zu sehen."
      say "    Mehr Details bekommst du mit:"
      say ""
      say "        ${C_BOLD}sudo ss -tulpn | grep ${CONFLICT_PORT}${C_RESET}"
    fi
    say ""
  fi

  say "    Die Fehlermeldung von Docker steht direkt darüber. Häufige Ursachen:"
  say "      • Ein Port ist wirklich belegt (siehe Warnungen oben)"
  say "      • Kein Speicherplatz mehr — aufräumen mit ${C_BOLD}docker system prune${C_RESET}"
  say "      • Keine Internetverbindung zum Herunterladen der Images"
  say ""
  say "    Logs ansehen:  ${C_BOLD}docker compose -f ${COMPOSE_FILE} logs${C_RESET}"
  say ""
  rm -f "${COMPOSE_LOG}"
  exit 4
fi

rm -f "${COMPOSE_LOG}"
ok "Container gestartet."

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 7 — Warten, bis Web-UI UND API bereit sind
# "Container gestartet" heißt noch nicht "Anwendung bereit": der Server muss
# erst hochfahren, die Datenbank migrieren usw. Deshalb fragen wir alle paar
# Sekunden nach, ob es schon so weit ist. Jeder Punkt = ein Versuch.
#
# Wichtig: die Web-UI ALLEIN ist kein verlässliches "bereit". Vor der Web-UI
# steht ein nginx, der schon Sekunden nach dem Container-Start ausliefert,
# während der Server dahinter noch migriert. Öffnen wir in diesem Moment den
# Browser, fragt die Seite den Einrichtungsstand ab, bekommt keine Antwort —
# und zeigt statt des Setup-Wizards das Login-Formular. Deshalb warten wir
# zusätzlich darauf, dass die API wirklich antwortet.
# ─────────────────────────────────────────────────────────────────────────────

step "Schritt 7/9 — Warten, bis Web-UI und API bereit sind (max. ${MAX_WAIT_SECONDS} Sekunden)"

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

# Rückgabe: 0 = die API ist wirklich bereit, 1 = noch nicht.
# Hier zählt — anders als oben — der HTTP-Status: /api/setup/status liefert erst
# dann eine 200, wenn der Server hochgefahren ist und die Datenbank erreicht.
# Genau diese Antwort braucht die Web-UI, um den Setup-Wizard zu zeigen.
is_api_ready() {
  local status
  if command -v curl >/dev/null 2>&1; then
    status="$(curl --silent --output /dev/null --max-time 3 \
      --write-out '%{http_code}' "${API_URL}/api/setup/status" 2>/dev/null)"
    [ "${status}" = "200" ]
    return $?
  fi

  # Fallback ohne curl: einen HTTP-Status können wir hier nicht lesen, also
  # bleibt nur der TCP-Test auf den API-Port. Schwächer als die Statusprüfung,
  # aber immer noch deutlich besser, als die API gar nicht zu beachten.
  if (exec 3<>/dev/tcp/localhost/8787) >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

STACK_READY=0
ATTEMPTS=$((MAX_WAIT_SECONDS / POLL_INTERVAL_SECONDS))
printf '    '

i=1
while [ "${i}" -le "${ATTEMPTS}" ]; do
  if is_pwa_reachable && is_api_ready; then
    STACK_READY=1
    break
  fi
  printf '.'
  sleep "${POLL_INTERVAL_SECONDS}"
  i=$((i + 1))
done
printf '\n'

if [ "${STACK_READY}" -eq 1 ]; then
  ok "Web-UI und API antworten (${PWA_URL})"
else
  warn "Web-UI und API haben nach ${MAX_WAIT_SECONDS} Sekunden noch nicht beide geantwortet."
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
