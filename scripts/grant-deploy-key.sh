#!/usr/bin/env bash
# grant-deploy-key.sh — einen angefragten Coolify-Deploy-Key freischalten.
#
# Hintergrund: Coolify (oder jeder andere Deploy-Runner) braucht einen eigenen
# Zugang zu diesem Repo. Der persönliche GitHub-Zugang der Nutzer reicht dafür
# nicht — ein Server kann sich nicht "als jemand" anmelden. Und einen Deploy-Key
# eintragen darf ausschliesslich, wer ADMIN-Rechte am Repo hat. Die Nutzer haben
# `write`, also können sie es nicht selbst. Deshalb: sie fragen per Issue an,
# dieses Script schaltet frei.
#
# Aufruf:
#   ./scripts/grant-deploy-key.sh <issue-nummer>
#       Liest den Key aus dem Issue, traegt ihn ein, kommentiert und schliesst es.
#
#   ./scripts/grant-deploy-key.sh --key "ssh-ed25519 AAAA... kommentar" --title "Coolify VPS von X"
#       Direkt, ohne Issue.
#
#   ./scripts/grant-deploy-key.sh --list
#       Alle eingetragenen Deploy-Keys anzeigen.
#
#   ./scripts/grant-deploy-key.sh --revoke <key-id>
#       Einen Key wieder entfernen (id aus --list).
#
# Der Key wird IMMER als read-only eingetragen. Coolify muss nur ziehen,
# niemals schreiben — es gibt keinen Grund, das aufzuweichen.

set -uo pipefail

REPO="${LOKYY_REPO:-oliverhees/lokyy-brain}"

C_RESET=""; C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s\n' "  ${C_GREEN}OK${C_RESET}  $*"; }
warn() { printf '%s\n' "  ${C_YELLOW}!${C_RESET}   $*"; }
fail() { printf '%s\n' "  ${C_RED}FEHLER${C_RESET}  $*"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

require_gh() {
  command -v gh >/dev/null 2>&1 || { fail "gh CLI nicht gefunden."; exit 1; }
  gh auth status >/dev/null 2>&1 || { fail "gh ist nicht angemeldet (gh auth login)."; exit 1; }
}

# Ein oeffentlicher SSH-Key ist eine Zeile: <typ> <base64> [kommentar].
# Wir pruefen Typ + Base64-Teil. Ein PRIVATER Key beginnt mit "-----BEGIN" —
# den lehnen wir ausdruecklich ab, statt ihn an GitHub zu schicken.
validate_key() {
  local key="$1"
  if printf '%s' "$key" | grep -q -- "-----BEGIN"; then
    fail "Das ist ein PRIVATER Schluessel. Niemals weitergeben."
    say  "        Der Nutzer soll den oeffentlichen Teil schicken (eine Zeile, beginnt mit ssh-...)."
    say  "        Falls der private Key bereits im Issue steht: er ist damit kompromittiert —"
    say  "        in Coolify ein neues Schluesselpaar erzeugen und das Issue loeschen (nicht nur schliessen)."
    return 1
  fi
  if ! printf '%s' "$key" | grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+'; then
    fail "Sieht nicht nach einem oeffentlichen SSH-Key aus."
    say  "        Erwartet: eine Zeile, z. B. 'ssh-ed25519 AAAAC3Nza... coolify'"
    return 1
  fi
  return 0
}

add_key() {
  local key="$1" title="$2" issue="${3:-}"
  local out status

  out=$(gh api "repos/${REPO}/keys" -X POST \
          -f "title=${title}" -f "key=${key}" -F read_only=true 2>&1)
  status=$?

  if [ $status -eq 0 ]; then
    local id
    id=$(printf '%s' "$out" | grep -o '"id": *[0-9]*' | head -n1 | grep -o '[0-9]*')
    ok "Deploy-Key eingetragen (read-only), id=${id}"

    if [ -n "$issue" ]; then
      gh issue comment "$issue" --repo "$REPO" --body \
"Deploy-Key ist eingetragen (nur Lesezugriff) — du kannst das Deployment jetzt starten.

Falls Coolify weiterhin meckert: einmal die Source-Verbindung im Coolify-UI neu testen, der Key wird nicht rueckwirkend fuer eine bereits fehlgeschlagene Verbindung uebernommen." >/dev/null 2>&1 \
        && gh issue close "$issue" --repo "$REPO" >/dev/null 2>&1 \
        && ok "Issue #${issue} kommentiert und geschlossen."
    fi
    return 0
  fi

  # GitHub laesst denselben Key nur bei EINEM Repository als Deploy-Key zu.
  # Das ist der mit Abstand haeufigste Fehlschlag — und die Fehlermeldung von
  # GitHub allein ist fuer Nicht-Techniker nicht selbsterklaerend.
  if printf '%s' "$out" | grep -qi "already in use"; then
    fail "GitHub lehnt den Key ab: er ist bereits bei einem anderen Repository eingetragen."
    say  ""
    say  "        Ein SSH-Key kann GitHub-weit nur bei EINEM Repo Deploy-Key sein."
    say  "        Loesung fuer den Nutzer: in Coolify ein NEUES Schluesselpaar"
    say  "        speziell fuer dieses Repo erzeugen und den neuen oeffentlichen"
    say  "        Key schicken."
    if [ -n "$issue" ]; then
      gh issue comment "$issue" --repo "$REPO" --body \
"GitHub hat den Key abgelehnt: **er ist schon bei einem anderen Repository als Deploy-Key eingetragen.**

Ein SSH-Key kann GitHub-weit immer nur bei *einem* Repo als Deploy-Key dienen. Bitte in Coolify ein **neues Schluesselpaar** speziell fuer dieses Repo erzeugen und den neuen oeffentlichen Key hier posten — dann trage ich ihn ein." >/dev/null 2>&1 \
        && warn "Issue #${issue} kommentiert (bleibt offen)."
    fi
    return 1
  fi

  fail "GitHub hat den Key abgelehnt:"
  printf '%s\n' "$out" | sed 's/^/        /'
  return 1
}

require_gh

case "${1:-}" in
  --list)
    say ""
    say "${C_BOLD}Eingetragene Deploy-Keys (${REPO})${C_RESET}"
    say ""
    gh api "repos/${REPO}/keys" \
      --jq '.[] | "  id=\(.id)\tread_only=\(.read_only)\t\(.title)"' 2>&1
    say ""
    ;;

  --revoke)
    [ -n "${2:-}" ] || { fail "Key-id fehlt. Ids siehst du mit --list."; exit 1; }
    if gh api "repos/${REPO}/keys/$2" -X DELETE >/dev/null 2>&1; then
      ok "Key $2 entfernt."
    else
      fail "Konnte Key $2 nicht entfernen (falsche id?)."
      exit 1
    fi
    ;;

  --key)
    [ -n "${2:-}" ] || { fail "--key braucht den Key als Argument."; exit 1; }
    KEY="$2"; TITLE="manuell-$(date +%Y%m%d)"
    [ "${3:-}" = "--title" ] && [ -n "${4:-}" ] && TITLE="$4"
    validate_key "$KEY" || exit 1
    add_key "$KEY" "$TITLE" || exit 1
    ;;

  ""|-h|--help)
    usage
    ;;

  *)
    ISSUE="$1"
    printf '%s' "$ISSUE" | grep -qE '^[0-9]+$' || { fail "Issue-Nummer erwartet (oder --key/--list/--revoke)."; exit 1; }

    BODY=$(gh issue view "$ISSUE" --repo "$REPO" --json body,author,title \
             --jq '.body' 2>/dev/null) || { fail "Issue #${ISSUE} nicht gefunden."; exit 1; }
    AUTHOR=$(gh issue view "$ISSUE" --repo "$REPO" --json author --jq '.author.login' 2>/dev/null)

    # Erste Zeile im Issue-Body, die wie ein oeffentlicher SSH-Key aussieht.
    KEY=$(printf '%s' "$BODY" | grep -oE '(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+) [A-Za-z0-9+/=]+( [^ ]*)?' | head -n1)
    if [ -z "$KEY" ]; then
      fail "Im Issue #${ISSUE} steht kein erkennbarer oeffentlicher SSH-Key."
      say  "        Schau selbst rein:  gh issue view ${ISSUE} --repo ${REPO}"
      exit 1
    fi

    validate_key "$KEY" || exit 1

    say ""
    say "  Issue   #${ISSUE} von ${C_BOLD}${AUTHOR}${C_RESET}"
    say "  Key     ${KEY:0:38}…"
    say "  Zugriff ${C_BOLD}nur lesen${C_RESET}"
    say ""
    printf "  Eintragen? [j/N] "
    read -r answer
    case "$answer" in
      j|J|y|Y) ;;
      *) warn "Abgebrochen."; exit 0 ;;
    esac

    add_key "$KEY" "${AUTHOR}-issue-${ISSUE}" "$ISSUE" || exit 1
    ;;
esac
