# install.ps1 — Lokyy Brain lokal starten (Windows).
#
# Das ist der ERSTE Schritt nach dem Download. Du musst `docker compose` NICHT
# selbst aufrufen — das erledigt dieses Script für dich.
#
# Was passiert hier, der Reihe nach:
#   1. Betriebssystem prüfen (dieses Script ist für Windows gedacht)
#   2. Prüfen, ob Docker installiert ist
#   3. Prüfen, ob der Docker-Daemon wirklich LÄUFT (nicht nur installiert ist)
#   4. Prüfen, ob "docker compose" (Version 2) verfügbar ist
#   5. Prüfen, ob die Ports frei sind, die Lokyy Brain braucht (nur Warnung)
#   6. Den Stack starten: docker compose -f docker-compose.local.yml up -d --build
#   7. Warten, bis die Web-UI erreichbar ist (erster Start baut Images = dauert)
#   8. Browser öffnen
#   9. Kurze Zusammenfassung "wie geht es weiter"
#
# Aufruf in PowerShell (im Projekt-Ordner):
#   .\install.ps1
#
# Falls Windows das Ausführen von Scripten blockiert ("... kann nicht geladen
# werden, da die Ausführung von Skripts auf diesem System deaktiviert ist"),
# hilft dieser Aufruf — er gilt nur für dieses eine Fenster:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# Exit-Codes:
#   0  alles gut
#   1  Docker ist nicht installiert
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  der Stack konnte nicht gestartet werden

# Fehler von PowerShell-Cmdlets sollen das Script nicht sofort abbrechen —
# wir prüfen jeden Schritt selbst und geben dazu eine verständliche Meldung aus.
# (Exit-Codes externer Programme wie docker landen ohnehin in $LASTEXITCODE.)
$ErrorActionPreference = 'Continue'

# ─────────────────────────────────────────────────────────────────────────────
# Konfiguration — hier stehen alle Werte, die sich ändern könnten
# ─────────────────────────────────────────────────────────────────────────────

$ComposeFile = 'docker-compose.local.yml'
$PwaUrl      = 'http://localhost:8095'
$ApiUrl      = 'http://localhost:8787'
$McpUrl      = 'http://localhost:8788/mcp'
$ForgejoUrl  = 'http://localhost:3001'

# Ports, die docker-compose.local.yml auf dem Host belegt.
$PortsToCheck = @(
    @{ Port = 8787; Label = 'Server-API' },
    @{ Port = 8095; Label = 'Web-UI (PWA)' },
    @{ Port = 8788; Label = 'MCP-Server' },
    @{ Port = 3001; Label = 'Forgejo Web-UI' },
    @{ Port = 2222; Label = 'Forgejo SSH' }
)

# Wie lange warten wir maximal, bis die Web-UI antwortet?
$MaxWaitSeconds      = 90
$PollIntervalSeconds = 2

# Doku-Link, falls Docker fehlt
$DocsWindows = 'https://docs.docker.com/desktop/setup/install/windows-install/'

# ─────────────────────────────────────────────────────────────────────────────
# Ausgabe-Helfer
# ─────────────────────────────────────────────────────────────────────────────

function Write-Step { param([string]$Text); Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text); Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text); Write-Host "    !   $Text" -ForegroundColor Yellow }
function Write-Fail { param([string]$Text); Write-Host "    FEHLER  $Text" -ForegroundColor Red }
function Write-Line { param([string]$Text = ''); Write-Host $Text }

# ─────────────────────────────────────────────────────────────────────────────
# In den Ordner wechseln, in dem DIESES Script liegt.
# Damit ist egal, aus welchem Verzeichnis du es aufrufst — die Compose-Datei
# wird immer relativ zum Repo gefunden.
# ─────────────────────────────────────────────────────────────────────────────

Set-Location $PSScriptRoot

Write-Line ''
Write-Host 'Lokyy Brain — lokale Installation' -ForegroundColor White
Write-Line "Projekt-Ordner: $PSScriptRoot"
Write-Line ''

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 1 — Betriebssystem prüfen
# $IsWindows gibt es erst ab PowerShell 6. Auf dem in Windows mitgelieferten
# Windows PowerShell 5.1 ist die Variable nicht definiert — dort erkennen wir
# Windows an der Umgebungsvariable $env:OS.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 1/9 — Betriebssystem erkennen'

$runningOnWindows = $false
if (Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue) {
    $runningOnWindows = $IsWindows
} elseif ($env:OS -eq 'Windows_NT') {
    $runningOnWindows = $true
}

if (-not $runningOnWindows) {
    Write-Warn 'Dieses Script ist für Windows gedacht.'
    Write-Line '    Auf macOS oder Linux bitte stattdessen aufrufen:  bash install.sh'
    Write-Line ''
} else {
    Write-Ok "System erkannt: Windows (PowerShell $($PSVersionTable.PSVersion))"
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 2 — Ist Docker überhaupt installiert?
# Wir installieren Docker BEWUSST nicht selbst: das braucht Admin-Rechte,
# meist einen Neustart und WSL2 im Hintergrund. Das machst du einmal von Hand,
# danach funktioniert dieses Script.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 2/9 — Docker-Installation prüfen'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail 'Docker ist auf diesem Rechner nicht installiert.'
    Write-Line ''
    Write-Line '  Lokyy Brain läuft komplett in Docker-Containern — ohne Docker geht nichts.'
    Write-Line '  Bitte installiere Docker Desktop einmalig und starte dieses Script danach erneut:'
    Write-Line ''
    Write-Host "      $DocsWindows" -ForegroundColor White
    Write-Line ''
    Write-Line '  Wichtig unter Windows: Docker Desktop benötigt WSL2 (Windows-Subsystem'
    Write-Line '  für Linux). Der Installer richtet das in der Regel automatisch ein und'
    Write-Line '  verlangt danach einen Neustart — den bitte wirklich durchführen.'
    Write-Line ''
    exit 1
}

$dockerVersion = (docker --version 2>$null)
Write-Ok "Docker gefunden: $dockerVersion"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 3 — Läuft der Docker-Daemon wirklich?
# Das ist der mit Abstand häufigste Stolperstein: Docker Desktop ist zwar
# installiert, wurde nach dem Rechnerstart aber nie geöffnet. Der Befehl
# "docker" existiert dann — nur antwortet niemand dahinter.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 3/9 — Docker-Daemon prüfen (läuft Docker gerade?)'

docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Fail 'Docker ist installiert, aber der Docker-Daemon antwortet nicht.'
    Write-Line ''
    Write-Line '  Bitte starte Docker Desktop (Startmenü) und warte, bis das Wal-Symbol'
    Write-Line '  unten rechts in der Taskleiste ruhig steht bzw. "Engine running" meldet.'
    Write-Line '  Beim ersten Start nach dem Hochfahren dauert das oft eine Minute.'
    Write-Line ''
    Write-Line '  Danach dieses Script einfach noch einmal aufrufen.'
    Write-Line ''
    exit 2
}

Write-Ok 'Docker-Daemon läuft.'

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 4 — "docker compose" (v2) verfügbar?
# Achtung: gemeint ist der Unterbefehl "docker compose" (mit Leerzeichen),
# nicht das alte eigenständige Programm "docker-compose" (mit Bindestrich).
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 4/9 — Compose-Plugin prüfen (docker compose v2)'

# Erst die komplette Ausgabe einsammeln, dann auswerten: würden wir direkt in
# "Select-Object -First 1" pipen, könnte PowerShell das Programm vorzeitig
# beenden und $LASTEXITCODE wäre nicht mehr verlässlich.
$composeOutput = (docker compose version 2>&1)
$composeVersionExit = $LASTEXITCODE
$composeVersion = ($composeOutput | Select-Object -First 1)

if ($composeVersionExit -ne 0) {
    Write-Fail 'Der Unterbefehl "docker compose" ist nicht verfügbar.'
    Write-Line ''
    Write-Line '  Lokyy Brain braucht Compose v2 — also "docker compose" (mit Leerzeichen),'
    Write-Line '  nicht das alte "docker-compose" (mit Bindestrich).'
    Write-Line ''
    Write-Line '  In Docker Desktop ist Compose v2 immer enthalten. Wenn es fehlt, ist die'
    Write-Line '  Installation vermutlich unvollständig oder veraltet — Anleitung:'
    Write-Line ''
    Write-Host "      $DocsWindows" -ForegroundColor White
    Write-Line ''
    exit 3
}

Write-Ok "Compose gefunden: $composeVersion"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 5 — Sind die benötigten Ports frei?
# Das ist NUR eine freundliche Vorwarnung. Wir brechen hier absichtlich nicht
# ab: vielleicht läuft dort schon ein früherer Lokyy-Brain-Start. Wenn wirklich
# ein Konflikt besteht, meldet Docker Compose das gleich selbst — nur eben in
# einer Sprache, die man erst mal übersetzen muss.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 5/9 — Ports prüfen (8787, 8095, 8788, 3001, 2222)'

# Prüft, ob auf einem Port bereits etwas lauscht.
# Wir nehmen bewusst einen direkten TCP-Verbindungsversuch statt
# Test-NetConnection: das ist deutlich schneller und funktioniert auch im
# mitgelieferten Windows PowerShell 5.1 ohne Zusatzmodule.
function Test-PortInUse {
    param([int]$Port)

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connectTask = $client.ConnectAsync('127.0.0.1', $Port)
        # Wait() liefert $false bei Zeitüberschreitung und wirft einen Fehler,
        # wenn die Verbindung aktiv abgelehnt wird — beides heißt: Port ist frei.
        if ($connectTask.Wait(1000) -and $client.Connected) {
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        # Close() gibt es in jeder .NET-Version. Dispose() ist im alten
        # .NET Framework nur über das Interface erreichbar und würde in
        # Windows PowerShell 5.1 unter Umständen scheitern.
        $client.Close()
    }
}

$portsBusy = 0
foreach ($entry in $PortsToCheck) {
    if (Test-PortInUse -Port $entry.Port) {
        Write-Warn "Port $($entry.Port) ($($entry.Label)) ist bereits belegt — dort läuft schon etwas anderes."
        $portsBusy++
    }
}

if ($portsBusy -gt 0) {
    Write-Line ''
    Write-Line '    Das ist kein Abbruchgrund — es kann auch ein früherer Lokyy-Brain-Start sein.'
    Write-Line '    Wenn es wirklich kollidiert, sagt Docker Compose gleich selbst Bescheid.'
    Write-Line '    Tipp: alte Container stoppen mit'
    Write-Line "        docker compose -f $ComposeFile down"
    Write-Line ''
} else {
    Write-Ok 'Alle benötigten Ports sind frei.'
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 6 — Den Stack starten
# Beim allerersten Mal werden hier Images gebaut und heruntergeladen.
# Das dauert je nach Internetverbindung durchaus ein paar Minuten.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 6/9 — Lokyy Brain starten (beim ersten Mal dauert das ein paar Minuten)'

if (-not (Test-Path $ComposeFile)) {
    Write-Fail "Die Datei $ComposeFile liegt nicht im Projekt-Ordner."
    Write-Line '    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde.'
    exit 4
}

Write-Line ''
docker compose -f $ComposeFile up -d --build
$composeExit = $LASTEXITCODE
Write-Line ''

if ($composeExit -ne 0) {
    Write-Fail "Der Start ist fehlgeschlagen (docker compose Exit-Code $composeExit)."
    Write-Line ''
    Write-Line '    Die Fehlermeldung von Docker steht direkt darüber. Häufige Ursachen:'
    Write-Line '      - Ein Port ist wirklich belegt (siehe Warnungen oben)'
    Write-Line '      - Kein Speicherplatz mehr — aufräumen mit: docker system prune'
    Write-Line '      - Keine Internetverbindung zum Herunterladen der Images'
    Write-Line ''
    Write-Line "    Logs ansehen:  docker compose -f $ComposeFile logs"
    Write-Line ''
    exit 4
}

Write-Ok 'Container gestartet.'

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 7 — Warten, bis die Web-UI antwortet
# "Container gestartet" heißt noch nicht "Anwendung bereit": der Server muss
# erst hochfahren, die Datenbank migrieren usw. Deshalb fragen wir alle paar
# Sekunden nach, ob die Seite schon antwortet. Jeder Punkt = ein Versuch.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step "Schritt 7/9 — Warten, bis die Web-UI erreichbar ist (max. $MaxWaitSeconds Sekunden)"

# Uns interessiert NUR, ob eine Verbindung zustande kommt — welcher HTTP-Status
# zurückkommt, ist an dieser Stelle egal.
function Test-PwaReachable {
    try {
        # -ErrorAction Stop ist hier PFLICHT: ohne das ist ein fehlgeschlagener
        # Verbindungsversuch in Windows PowerShell 5.1 nur ein "nicht
        # abbrechender" Fehler — der catch-Block würde nicht greifen und die
        # Funktion würde faelschlicherweise "erreichbar" melden.
        Invoke-WebRequest -Uri $PwaUrl -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
        return $true
    } catch {
        # Wichtig: Invoke-WebRequest wirft bei 4xx/5xx einen Fehler. Wenn eine
        # Response dabei ist, hat der Server aber geantwortet — also erreichbar.
        if ($_.Exception.Response) {
            return $true
        }
        return $false
    }
}

$pwaReady = $false
$attempts = [int]($MaxWaitSeconds / $PollIntervalSeconds)
Write-Host '    ' -NoNewline

for ($i = 1; $i -le $attempts; $i++) {
    if (Test-PwaReachable) {
        $pwaReady = $true
        break
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds $PollIntervalSeconds
}
Write-Line ''

if ($pwaReady) {
    Write-Ok "Web-UI antwortet unter $PwaUrl"
} else {
    Write-Warn "Die Web-UI hat nach $MaxWaitSeconds Sekunden noch nicht geantwortet."
    Write-Line '    Das ist beim allerersten Start normal (Images bauen dauert).'
    Write-Line '    Wir öffnen den Browser trotzdem — lade die Seite in ein bis zwei'
    Write-Line '    Minuten einfach neu.'
    Write-Line "    Status ansehen:  docker compose -f $ComposeFile ps"
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 8 — Browser öffnen
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 8/9 — Browser öffnen'

try {
    # -ErrorAction Stop, damit ein Fehlschlag wirklich im catch-Block landet.
    Start-Process $PwaUrl -ErrorAction Stop | Out-Null
    Write-Ok 'Browser wird geöffnet.'
} catch {
    Write-Warn 'Browser konnte nicht automatisch geöffnet werden — bitte die Adresse von Hand öffnen:'
    Write-Line "    $PwaUrl"
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 9 — Wie geht es weiter?
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 9/9 — Fertig'

Write-Line ''
Write-Host 'Lokyy Brain läuft.' -ForegroundColor Green
Write-Line ''
Write-Line "  Web-UI (hier geht es los)   $PwaUrl"
Write-Line "  Server-API                  $ApiUrl"
Write-Line "  MCP-Endpoint                $McpUrl"
Write-Line "  Forgejo (optional)          $ForgejoUrl"
Write-Line ''
Write-Host 'Nächster Schritt' -ForegroundColor White
Write-Line '  Im Browser startet automatisch der Setup-Wizard und führt dich durch'
Write-Line '  den Rest — Admin-Account, Vault, Datenbank, Embeddings.'
Write-Line '  Bei der Forgejo-Frage kannst du getrost'
Write-Line '  "Ohne Forgejo fortfahren (nur lokal)" wählen: dann läuft alles rein'
Write-Line '  lokal, ohne externen Git-Server. Nachrüsten geht jederzeit.'
Write-Line ''
Write-Host 'KI-Agenten anbinden (MCP)' -ForegroundColor White
Write-Line "  Endpoint:  $McpUrl"
Write-Line "  Auth:      Bearer-Token = der Wert von LOKYY_MCP_TOKEN in $ComposeFile"
Write-Line '             (Standard ist nur ein Platzhalter zum Testen —'
Write-Line '             für den echten Einsatz bitte ändern.)'
Write-Line ''
Write-Host 'Nützliche Befehle' -ForegroundColor White
Write-Line "  Status:    docker compose -f $ComposeFile ps"
Write-Line "  Logs:      docker compose -f $ComposeFile logs -f"
Write-Line "  Stoppen:   docker compose -f $ComposeFile down"
Write-Line ''

exit 0
