# install.ps1 — Lokyy Brain lokal starten (Windows).
#
# Das ist der ERSTE Schritt nach dem Download. Du musst `docker compose` NICHT
# selbst aufrufen — das erledigt dieses Script für dich.
#
# Was passiert hier, der Reihe nach:
#   1. Betriebssystem prüfen (dieses Script ist für Windows gedacht)
#   2. Prüfen, ob Docker installiert ist — und es bei Bedarf automatisch
#      installieren (über winget; fehlt winget selbst, wird zuerst der
#      "App Installer" von Microsoft nachgerüstet). Klappt das nicht,
#      bleibt es beim Link zum Selbermachen.
#   3. Prüfen, ob der Docker-Daemon wirklich LÄUFT (nicht nur installiert ist)
#   4. Prüfen, ob "docker compose" (Version 2) verfügbar ist
#   5. Prüfen, ob die Ports frei sind, die Lokyy Brain braucht (nur Warnung)
#   6. Bei einer NEUEN Installation ein eigenes Datenbank-Passwort erzeugen und
#      in .env hinterlegen (bestehende Installationen bleiben unangetastet);
#      dazu einmalig das Geheimnis für den Ein-Klick-Updater (LOKYY_UPDATER_TOKEN)
#   7. Den Stack starten: docker compose -f docker-compose.local.yml up -d --build
#      (hängt noch ein Port-Rest aus einem früheren Lauf, wird EINMAL automatisch
#       aufgeräumt und neu gestartet; sonst folgt eine Diagnose, wer den Port hält)
#   8. Warten, bis Web-UI UND API bereit sind (erster Start baut Images = dauert;
#      die Web-UI allein antwortet schon, während der Server noch hochfährt)
#   9. Browser öffnen
#  10. Kurze Zusammenfassung "wie geht es weiter"
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
#   1  Docker fehlt und konnte nicht automatisch installiert werden
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  der Stack konnte nicht gestartet werden
#   5  Es wurde etwas installiert, aber EIN manueller Schritt fehlt noch:
#      Windows neu starten (WSL2) bzw. ein neues PowerShell-Fenster öffnen.
#      Danach dieses Script einfach erneut aufrufen. Kein echter Fehler.

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
$ForgejoUrl  = 'http://localhost:8790'

# Ports, die docker-compose.local.yml auf dem Host belegt.
$PortsToCheck = @(
    @{ Port = 8787; Label = 'Server-API' },
    @{ Port = 8095; Label = 'Web-UI (PWA)' },
    @{ Port = 8788; Label = 'MCP-Server' },
    @{ Port = 8790; Label = 'Forgejo Web-UI' }
)

# Wie lange warten wir maximal, bis Web-UI und API antworten?
$MaxWaitSeconds      = 90
$PollIntervalSeconds = 2

# Wie lange warten wir maximal, bis Docker Desktop nach einer frischen
# Installation hochgefahren ist?
$DockerStartWaitSeconds = 60

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

Write-Step 'Schritt 1/10 — Betriebssystem erkennen'

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
# Fehlt Docker, installieren wir es selbst — über winget, das Paket-Werkzeug
# von Microsoft. Fehlt winget seinerseits, rüsten wir es vorher nach.
# Zwei Dinge kann ein Script prinzipbedingt NICHT übernehmen: den UAC-Dialog
# bestätigen und den Rechner neu starten. Beides sagen wir deshalb klar an.
# ─────────────────────────────────────────────────────────────────────────────

# Der klassische "mach es bitte von Hand"-Hinweis — überall dieselbe Meldung.
function Write-DockerManualHint {
    Write-Line ''
    Write-Line '  Lokyy Brain läuft komplett in Docker-Containern — ohne Docker geht nichts.'
    Write-Line '  Bitte installiere Docker Desktop einmalig von Hand und starte dieses Script danach erneut:'
    Write-Line ''
    Write-Host "      $DocsWindows" -ForegroundColor White
    Write-Line ''
    Write-Line '  Wichtig unter Windows: Docker Desktop benötigt WSL2 (Windows-Subsystem'
    Write-Line '  für Linux). Der Installer richtet das in der Regel automatisch ein und'
    Write-Line '  verlangt danach einen Neustart — den bitte wirklich durchführen.'
    Write-Line ''
}

# Antwortet der Docker-Daemon? "docker" ist ein externes Programm; fehlt es
# ganz, wirft PowerShell einen abbrechenden Fehler — den fangen wir hier ab,
# damit die Warteschleife weiterlaufen kann.
function Test-DockerReady {
    try {
        docker info 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

# Wartet auf den Docker-Daemon. Jeder Punkt = ein Versuch.
function Wait-DockerReady {
    param([int]$TimeoutSeconds)

    $waited = 0
    Write-Host '    ' -NoNewline
    while ($waited -lt $TimeoutSeconds) {
        if (Test-DockerReady) {
            Write-Line ''
            return $true
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds $PollIntervalSeconds
        $waited += $PollIntervalSeconds
    }
    Write-Line ''
    return $false
}

# Ist WSL2 einsatzbereit? Docker Desktop setzt es zwingend voraus.
# Wir werten bewusst nur die Exit-Codes aus: die Textausgabe von wsl.exe ist
# UTF-16 und wird in Windows PowerShell 5.1 gern als Kauderwelsch dargestellt —
# darauf kann man keine Prüfung aufbauen.
function Test-Wsl2Ready {
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        return $false
    }
    wsl --status 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        return $true
    }
    # Ältere Windows-Builds kennen "--status" noch nicht — dann fragen wir
    # ersatzweise die Liste der installierten Distributionen ab.
    wsl -l -v 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

Write-Step 'Schritt 2/10 — Docker-Installation prüfen'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Warn 'Docker ist auf diesem Rechner nicht installiert.'

    # ── 2a) winget vorhanden? Sonst zuerst den "App Installer" nachrüsten ──
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Line ''
        Write-Line '  Es fehlt auch winget — das ist Microsofts Paket-Werkzeug (Teil des'
        Write-Line '  "App Installers"). Wir rüsten es zuerst nach und installieren damit'
        Write-Line '  anschließend Docker Desktop.'
        Write-Line ''

        # Ältere Windows-Installationen verhandeln von sich aus noch TLS 1.0/1.1.
        # GitHub und Microsoft nehmen das nicht mehr an — deshalb hier explizit.
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        } catch {
            Write-Warn 'TLS 1.2 konnte nicht gesetzt werden — wir versuchen es trotzdem.'
        }

        $vcLibsPath = Join-Path $env:TEMP 'lokyy-vclibs.appx'
        $bundlePath = Join-Path $env:TEMP 'lokyy-appinstaller.msixbundle'

        # Voraussetzung VCLibs. Ist das Paket bereits vorhanden, meldet Windows
        # einen Fehler — das ist kein Abbruchgrund, wir machen einfach weiter.
        # Bewusste Vereinfachung: Microsoft.UI.Xaml holen wir NICHT extra. Alle
        # aktuellen Windows-10/11-Builds bringen es mit; nur sehr alte Systeme
        # bräuchten es, und die sind hier ohnehin der Fall für den Handbetrieb.
        try {
            Write-Line '  Lade Voraussetzung (VCLibs) ...'
            Invoke-WebRequest -Uri 'https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx' -OutFile $vcLibsPath -UseBasicParsing -ErrorAction Stop
            Add-AppxPackage -Path $vcLibsPath -ErrorAction Stop
        } catch {
            Write-Warn 'VCLibs wurde nicht neu installiert — vermutlich ist es bereits vorhanden.'
        }

        $appInstallerOk = $false
        try {
            Write-Line '  Suche die aktuelle Version des App Installers ...'
            $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/microsoft/winget-cli/releases/latest' -UseBasicParsing -ErrorAction Stop
            $asset = $release.assets | Where-Object { $_.name -like '*.msixbundle' } | Select-Object -First 1
            if (-not $asset) {
                throw 'Im aktuellen Release ist kein .msixbundle enthalten.'
            }

            Write-Line "  Lade $($asset.name) ..."
            Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $bundlePath -UseBasicParsing -ErrorAction Stop
            Add-AppxPackage -Path $bundlePath -ErrorAction Stop
            $appInstallerOk = $true
        } catch {
            Write-Fail 'Der App Installer (winget) konnte nicht automatisch nachgerüstet werden.'
            Write-Line "    Grund: $($_.Exception.Message)"
        }

        if (-not $appInstallerOk) {
            Write-DockerManualHint
            exit 1
        }

        # Frisch registrierte Appx-Pakete landen im PATH einer BEREITS laufenden
        # PowerShell nicht zuverlässig. Ein neues Fenster ist hier der ehrliche
        # Weg — daran mitten in der Sitzung herumzubiegen ist unzuverlässig.
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Write-Ok 'winget wurde installiert — in diesem Fenster ist es aber noch nicht verfügbar.'
            Write-Line ''
            Write-Line '  Bitte öffne ein NEUES PowerShell-Fenster und rufe dort erneut auf:'
            Write-Line ''
            Write-Host '      .\install.ps1' -ForegroundColor White
            Write-Line ''
            Write-Line '  Das ist kein Fehler — es fehlt nur dieser eine Handgriff.'
            Write-Line ''
            exit 5
        }

        Write-Ok 'winget wurde installiert.'
    }

    # ── 2b) Docker Desktop über winget installieren ──
    Write-Line ''
    Write-Line '  Docker Desktop wird jetzt automatisch über winget installiert.'
    Write-Line '  Windows fragt dabei sehr wahrscheinlich per UAC-Fenster nach deiner'
    Write-Line '  Zustimmung ("Möchten Sie zulassen, dass diese App Änderungen an Ihrem'
    Write-Line '  Gerät vornimmt?"). Das ist normal und für jede Installation nötig —'
    Write-Line '  bitte mit "Ja" bestätigen. Der Download dauert ein paar Minuten.'
    Write-Line ''

    winget install -e --id Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "Die automatische Installation von Docker Desktop ist fehlgeschlagen (winget Exit-Code $LASTEXITCODE)."
        Write-DockerManualHint
        exit 1
    }

    Write-Ok 'Docker Desktop wurde installiert.'

    # Der PATH dieser laufenden Sitzung kennt das frisch installierte docker.exe
    # noch nicht — Windows aktualisiert ihn nur für NEU gestartete Prozesse.
    # Also holen wir ihn uns direkt aus der Registry-Umgebung.
    $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [System.Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'

    # ── 2c) WSL2 — ohne das läuft Docker Desktop unter Windows nicht ──
    if (-not (Test-Wsl2Ready)) {
        Write-Line ''
        Write-Warn 'Docker Desktop ist installiert — Windows braucht jetzt aber einen Neustart.'
        Write-Line ''
        Write-Line '  Grund: Docker Desktop läuft unter Windows auf WSL2 (Windows-Subsystem'
        Write-Line '  für Linux). Das wird beim ersten Mal eingerichtet und ist erst nach'
        Write-Line '  einem Neustart wirklich einsatzbereit.'
        Write-Line ''
        Write-Line '  Bitte starte den Rechner neu und rufe danach erneut auf:'
        Write-Line ''
        Write-Host '      .\install.ps1' -ForegroundColor White
        Write-Line ''
        Write-Line '  Das ist kein Fehler — es fehlt nur dieser eine Schritt.'
        Write-Line ''
        exit 5
    }

    # ── 2d) Docker Desktop starten und warten, bis es bereit ist ──
    Write-Line ''
    Write-Line '  Wir starten Docker Desktop jetzt.'
    Write-Line ''

    # Der Installationspfad kann abweichen — deshalb try/catch statt Test-Path
    # allein. -ErrorAction Stop, damit ein Fehlschlag wirklich im catch landet.
    $dockerDesktopExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    try {
        Start-Process -FilePath $dockerDesktopExe -ErrorAction Stop
    } catch {
        Write-Warn 'Docker Desktop konnte nicht automatisch gestartet werden — bitte einmal über das Startmenü öffnen.'
    }

    Write-Line "  Warten, bis Docker bereit ist (max. $DockerStartWaitSeconds Sekunden):"
    if (-not (Wait-DockerReady -TimeoutSeconds $DockerStartWaitSeconds)) {
        Write-Warn 'Docker Desktop ist noch nicht bereit.'
        Write-Line '    Beim allerersten Start dauert das manchmal länger.'
        Write-Line '    Bitte starte Docker Desktop einmal manuell (Startmenü), warte auf'
        Write-Line '    "Engine running" — und führe dieses Script danach erneut aus.'
        Write-Line ''
        exit 1
    }

    Write-Ok 'Docker Desktop läuft.'
}

$dockerVersion = (docker --version 2>$null)
Write-Ok "Docker gefunden: $dockerVersion"

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 3 — Läuft der Docker-Daemon wirklich?
# Das ist der mit Abstand häufigste Stolperstein: Docker Desktop ist zwar
# installiert, wurde nach dem Rechnerstart aber nie geöffnet. Der Befehl
# "docker" existiert dann — nur antwortet niemand dahinter.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 3/10 — Docker-Daemon prüfen (läuft Docker gerade?)'

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

Write-Step 'Schritt 4/10 — Compose-Plugin prüfen (docker compose v2)'

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

Write-Step 'Schritt 5/10 — Ports prüfen (8787, 8095, 8788, 8790)'

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
# Schritt 6 — Datenbank-Passwort für DIESE Installation
#
# Ohne eigenes Passwort läuft jede Installation weltweit auf demselben
# Standardwert, der im öffentlichen Repo steht. Neue Installationen bekommen
# deshalb hier ein zufälliges, eigenes.
#
# ACHTUNG, der wichtigste Satz in dieser Datei: Postgres übernimmt
# POSTGRES_PASSWORD ausschließlich beim ALLERERSTEN Start eines Daten-Volumes.
# Danach steht das Passwort in der Datenbank fest. Wer einer bestehenden
# Installation nachträglich ein neues Passwort unterschiebt, sperrt sie aus
# ihrer eigenen Datenbank aus — ein Totalausfall, ausgelöst durch ein Update.
# Genau deshalb erzeugen wir nur dann eines, wenn beides zutrifft:
#   • es gibt noch keine .env mit POSTGRES_PASSWORD  UND
#   • es gibt noch kein Postgres-Volume dieser Installation.
# Und wenn wir das nicht sicher feststellen können (Docker antwortet nicht,
# Projektname unklar), passiert NICHTS. Ein Standardwert zu viel ist ärgerlich,
# eine ausgesperrte Datenbank ist ein Datenverlust-Risiko.
#
# Diese Logik ist die Schwester des Blocks "db-password-bootstrap" in
# install.sh — ändert sich eine Seite, muss die andere nachgezogen werden.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 6/10 — Datenbank-Passwort und Ein-Klick-Updater'

# BEGIN db-password-bootstrap
$EnvFile = '.env'

# Erzeugt ein zufälliges Passwort — bewusst NUR Buchstaben und Ziffern.
# Der Wert landet unverändert in einer postgres://…-URL (Sonderzeichen müsste
# man dort prozentkodieren) und in einer .env, die Docker Compose selbst noch
# einmal interpretiert ("$" wäre dort der Anfang einer Variablen).
function New-DbPassword {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Wie heißt das Compose-Projekt? Alle Regeln dafür kennt nur Compose selbst
# (COMPOSE_PROJECT_NAME, ein "name:" in der Compose-Datei, die Bereinigung des
# Ordnernamens) — also fragen wir Compose. Die erste Zeile von "config" ist
# "name: <projekt>". Nur wenn das nicht klappt, leiten wir selbst ab.
function Get-ComposeProjectName {
    $configOutput = @(docker compose -f $ComposeFile config 2>$null)
    foreach ($line in $configOutput) {
        if ("$line" -match '^name:\s*(.+?)\s*$') {
            return $Matches[1]
        }
    }
    $derived = (Split-Path -Leaf $PSScriptRoot).ToLower() -replace '[^a-z0-9_-]', '_'
    if ([string]::IsNullOrWhiteSpace($derived)) { return $null }
    return $derived
}

# Gibt es das Postgres-Volume dieser Installation schon?
# Compose benennt Volumes "<projekt>_<schlüssel>"; der Schlüssel steht unten in
# der Compose-Datei unter "volumes:" als postgres-data. Bewusst der exakte Name
# und kein Suchmuster — ein Muster träfe womöglich das Volume eines fremden
# Docker-Projekts auf demselben Rechner.
function Test-PostgresVolumeExists {
    param([string]$Project)
    if ([string]::IsNullOrWhiteSpace($Project)) { return $false }
    docker volume inspect "${Project}_postgres-data" 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# Schreibt UTF-8 OHNE BOM. Set-Content würde in Windows PowerShell 5.1 ein BOM
# voranstellen — Docker Compose läse den ersten Schlüssel dann als "﻿POSTGRES_PASSWORD"
# und würde das Passwort stillschweigend ignorieren.
function Write-EnvText {
    param([string]$Path, [string]$Text, [bool]$Append)
    $encoding = New-Object System.Text.UTF8Encoding($false)
    $full = [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Path))
    if ($Append) {
        [System.IO.File]::AppendAllText($full, $Text, $encoding)
    } else {
        [System.IO.File]::WriteAllText($full, $Text, $encoding)
    }
}

$envHasPassword = $false
if (Test-Path $EnvFile) {
    $envHasPassword = @(Get-Content $EnvFile -ErrorAction SilentlyContinue |
                        Where-Object { $_ -match '^\s*POSTGRES_PASSWORD=' }).Count -gt 0
}

# Antwortet Docker überhaupt? Wenn nicht, können wir das vorhandene Volume
# nicht sehen — und dürfen dann auf keinen Fall ein Passwort erzeugen.
docker volume ls --quiet 2>$null | Out-Null
$dockerVolumesReadable = ($LASTEXITCODE -eq 0)

if ($envHasPassword) {
    Write-Ok 'Diese Installation hat bereits ein eigenes Datenbank-Passwort (in .env).'
} elseif (-not $dockerVolumesReadable) {
    Write-Warn 'Die vorhandenen Docker-Volumes lassen sich gerade nicht auflisten.'
    Write-Line '    Wir lassen die Datenbank deshalb unangetastet — der Start läuft normal weiter.'
} else {
    $composeProject = Get-ComposeProjectName

    if ([string]::IsNullOrWhiteSpace($composeProject)) {
        Write-Warn 'Der Name des Compose-Projekts ließ sich nicht ermitteln.'
        Write-Line '    Wir lassen die Datenbank deshalb unangetastet — der Start läuft normal weiter.'
    } elseif (Test-PostgresVolumeExists -Project $composeProject) {
        Write-Ok 'Bestehende Installation erkannt — die Datenbank bleibt unverändert.'
        Write-Line '    Dein Datenbank-Passwort bleibt der mitgelieferte Standardwert. Von außen'
        Write-Line '    ist die Datenbank nicht erreichbar (sie veröffentlicht keinen Port), du'
        Write-Line '    musst also nichts tun. Wenn du trotzdem umstellen möchtest, steht der'
        Write-Line '    Weg in der README unter "Eigenes Datenbank-Passwort nachrüsten".'
    } else {
        $dbPassword = New-DbPassword

        if ([string]::IsNullOrWhiteSpace($dbPassword) -or $dbPassword.Length -lt 24) {
            Write-Warn 'Es ließ sich kein zufälliges Passwort erzeugen.'
            Write-Line '    Die Installation läuft mit dem Standardwert weiter.'
        } elseif (Test-Path $EnvFile) {
            # .env gibt es schon (z. B. für API-Schlüssel), nur ohne Passwort-Zeile:
            # anhängen, nie überschreiben.
            $block = "`r`n" +
                     "# Von install.ps1 erzeugt — gilt nur für diese Installation.`r`n" +
                     "# Nicht nachträglich ändern: siehe Kommentar in der README.`r`n" +
                     "POSTGRES_PASSWORD=$dbPassword`r`n"
            Write-EnvText -Path $EnvFile -Text $block -Append $true
            Write-Ok 'Eigenes Datenbank-Passwort erzeugt und an .env angehängt.'
        } else {
            $block = "# lokyy-brain — Einstellungen dieser Installation.`r`n" +
                     "# Von install.ps1 angelegt. Gehört NICHT ins Git (steht in .gitignore).`r`n" +
                     "#`r`n" +
                     "# POSTGRES_PASSWORD wird beim allerersten Start fest in die Datenbank`r`n" +
                     "# geschrieben. Änderst du den Wert hier einfach nachträglich, sperrst du`r`n" +
                     "# dich aus deiner eigenen Datenbank aus — die kennt dann weiter den alten.`r`n" +
                     "# Zum Wechseln siehe README, Abschnitt `"Eigenes Datenbank-Passwort nachrüsten`".`r`n" +
                     "POSTGRES_PASSWORD=$dbPassword`r`n"
            Write-EnvText -Path $EnvFile -Text $block -Append $false
            Write-Ok 'Eigenes Datenbank-Passwort erzeugt und in .env hinterlegt (Datei bleibt lokal).'
        }
    }
}
# END db-password-bootstrap

# ─────────────────────────────────────────────────────────────────────────────
# Immer noch Schritt 6 — Geheimnis für den Ein-Klick-Updater
#
# Der Brain aktualisiert sich nicht selbst; er reicht "Jetzt aktualisieren" an
# den Sidecar lokyy-updater weiter. Beide Dienste müssen dasselbe Geheimnis
# kennen, sonst lehnt der Updater jede Anfrage ab und die Oberfläche zeigt
# statt des Knopfes einen Hinweis. Compose reicht denselben .env-Wert an beide
# weiter — eine Zeile genügt also für beide Seiten.
#
# Anders als beim Datenbank-Passwort ist ein späteres Nachrüsten hier
# ungefährlich: das Geheimnis wird nirgends eingebrannt, es wird bei jedem
# Start neu aus der .env gelesen. Deshalb erzeugen wir es auch für BESTEHENDE
# Installationen — genau die haben es nach einem Update auf v1.11+ noch nicht.
# Vorhandene Werte bleiben unangetastet.
#
# Diese Logik ist die Schwester des Blocks "updater-token-bootstrap" in
# install.sh — ändert sich eine Seite, muss die andere nachgezogen werden.
# ─────────────────────────────────────────────────────────────────────────────

# BEGIN updater-token-bootstrap

# Gleiche Bauart wie das Datenbank-Passwort: nur Buchstaben und Ziffern, damit
# der Wert unverändert durch .env und Compose läuft ("$" wäre dort der Anfang
# einer Variablen). Der Updater verlangt mindestens 16 Zeichen.
function New-UpdaterToken {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($bytes)
    } finally {
        $rng.Dispose()
    }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

# Bewusst auf einen NICHT-LEEREN Wert geprüft, nicht bloß auf die Zeile: die
# mitgelieferte .env.example enthält "LOKYY_UPDATER_TOKEN=" ohne Wert, und wer
# sie kopiert hat, hätte damit einen Updater, der jedes Update verweigert.
# Hängen wir in dem Fall unten eine zweite Zeile an, gewinnt sie — Compose
# liest die .env von oben nach unten und die letzte Zuweisung zählt.
$envHasUpdaterToken = $false
if (Test-Path $EnvFile) {
    $envHasUpdaterToken = @(Get-Content $EnvFile -ErrorAction SilentlyContinue |
                            Where-Object { $_ -match '^\s*LOKYY_UPDATER_TOKEN=\s*\S' }).Count -gt 0
}

if ($envHasUpdaterToken) {
    Write-Ok 'Der Ein-Klick-Updater ist bereits eingerichtet (Wert steht in .env).'
} else {
    $updaterToken = New-UpdaterToken

    if ([string]::IsNullOrWhiteSpace($updaterToken) -or $updaterToken.Length -lt 24) {
        Write-Warn 'Es ließ sich kein Geheimnis für den Updater erzeugen.'
        Write-Line '    Die Installation läuft normal weiter — nur der Knopf "Jetzt aktualisieren"'
        Write-Line '    fehlt dann; aktualisieren geht weiterhin über ".\install.ps1".'
    } elseif (Test-Path $EnvFile) {
        $block = "`r`n" +
                 "# Von install.ps1 erzeugt — gilt nur für diese Installation.`r`n" +
                 "# Gemeinsames Geheimnis von lokyy-brain und lokyy-updater. Änderst du es,`r`n" +
                 "# starte beide Dienste neu (.\install.ps1 genügt).`r`n" +
                 "LOKYY_UPDATER_TOKEN=$updaterToken`r`n"
        Write-EnvText -Path $EnvFile -Text $block -Append $true
        Write-Ok 'Ein-Klick-Updater eingerichtet (Geheimnis an .env angehängt).'
    } else {
        # Keine .env vorhanden (z. B. weil oben nichts erzeugt wurde). Neu anlegen.
        $block = "# lokyy-brain — Einstellungen dieser Installation.`r`n" +
                 "# Von install.ps1 angelegt. Gehört NICHT ins Git (steht in .gitignore).`r`n" +
                 "#`r`n" +
                 "# Gemeinsames Geheimnis von lokyy-brain und lokyy-updater. Änderst du es,`r`n" +
                 "# starte beide Dienste neu (.\install.ps1 genügt).`r`n" +
                 "LOKYY_UPDATER_TOKEN=$updaterToken`r`n"
        Write-EnvText -Path $EnvFile -Text $block -Append $false
        Write-Ok 'Ein-Klick-Updater eingerichtet (Geheimnis in .env hinterlegt, Datei bleibt lokal).'
    }
}
# END updater-token-bootstrap

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 7 — Den Stack starten
# Beim allerersten Mal werden hier Images gebaut und heruntergeladen.
# Das dauert je nach Internetverbindung durchaus ein paar Minuten.
#
# Bekannter Docker-Stolperstein beim ZWEITEN Lauf: aus einem früheren, evtl.
# abgebrochenen "up" hängt noch ein Container-Rest am Port ("port is already
# allocated"). Genau diesen Fall räumen wir automatisch auf (down) und starten
# danach GENAU EINMAL neu. Alle anderen Fehler (kein Platz, kein Internet,
# Build kaputt) werden NICHT wiederholt — das würde nur Zeit kosten.
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 7/10 — Lokyy Brain starten (beim ersten Mal dauert das ein paar Minuten)'

if (-not (Test-Path $ComposeFile)) {
    Write-Fail "Die Datei $ComposeFile liegt nicht im Projekt-Ordner."
    Write-Line '    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde.'
    exit 4
}

$composeLog = Join-Path $env:TEMP "lokyy-compose-$PID.log"

# Startet den Stack. Die Ausgabe brauchen wir zweimal: live auf dem Bildschirm
# (der Build läuft minutenlang — ohne Ausgabe sieht das aus wie ein Absturz)
# UND als Datei, um sie im Fehlerfall auswerten zu können. Beides zugleich
# leistet Tee-Object.
#
# Vier Feinheiten, die hier bewusst so stehen:
#   • 2>&1 holt die Fehlerausgabe von docker in die normale Pipeline — sonst
#     landet ausgerechnet die entscheidende Zeile ("port is already allocated")
#     nicht in der Datei. Das ist unbedenklich, weil ganz oben
#     $ErrorActionPreference = 'Continue' gesetzt ist.
#   • ForEach-Object { "$_" } macht daraus wieder schlichten Text. Docker
#     schreibt seinen Fortschritt ("Container ... Started") auf die
#     Fehlerausgabe; ohne diese Umwandlung würde Windows PowerShell jede
#     einzelne Bauzeile als roten Fehlerblock mit CategoryInfo-Anhang malen.
#   • Out-Host am Ende: ohne das würden die durchgereichten Zeilen zum
#     RÜCKGABEWERT dieser Funktion — wir wollen aber nur den Exit-Code.
#   • $LASTEXITCODE setzen ausschließlich EXTERNE Programme; Cmdlets wie
#     ForEach-Object, Tee-Object oder Out-Host fassen ihn nicht an. Nach der
#     Pipeline steht darin also weiterhin der Exit-Code von docker selbst.
#     (Anders als bei "Select-Object -First 1" — das kann ein Programm
#     vorzeitig beenden und den Exit-Code verfälschen; die Cmdlets hier lesen
#     die Ausgabe immer vollständig zu Ende.)
function Invoke-ComposeUp {
    param([string]$LogPath)

    docker compose -f $ComposeFile up -d --build 2>&1 |
        ForEach-Object { "$_" } |
        Tee-Object -FilePath $LogPath |
        Out-Host
    return $LASTEXITCODE
}

# Liest das Protokoll als einen einzigen Text zurück. Get-Content erkennt die
# Kodierung von Tee-Object selbst (BOM) — und die Zeichenketten, nach denen wir
# suchen, sind ohnehin reines ASCII.
function Get-ComposeLogText {
    param([string]$LogPath)

    if (-not (Test-Path $LogPath)) { return '' }
    $text = Get-Content -Path $LogPath -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { return '' }
    return [string]$text
}

Write-Line ''
$composeExit = Invoke-ComposeUp -LogPath $composeLog
$composeOutput = Get-ComposeLogText -LogPath $composeLog
Write-Line ''

# Zwei bekannte, selbstheilbare Fehlerbilder. Alles andere (kein Internet,
# kein Speicherplatz, ein echter Build-Fehler) wird NICHT wiederholt -- das
# würde nur einen mehrminütigen Build umsonst kosten.
if ($composeExit -ne 0 -and $composeOutput -match 'port is already allocated') {
    Write-Warn 'Ein Port ist noch belegt — das sieht nach einem Rest aus einem früheren Start aus.'
    Write-Line '    Wir räumen den alten Stack automatisch ab und versuchen es genau einmal erneut.'
    Write-Line ''

    # Aufräumen ist ein Versuch, keine Bedingung: Ausgabe unterdrücken,
    # Exit-Code bewusst ignorieren.
    docker compose -f $ComposeFile down --remove-orphans 2>&1 | Out-Null

    # "down" kehrt zurück, sobald Docker die Container entfernt hat -- der
    # Host-Port wird dabei aber nicht IMMER synchron wieder freigegeben. Ein
    # sofortiger Retry kann deshalb denselben Fehler nochmal auslösen, obwohl
    # nur unser eigener alter Prozess noch beim Aufräumen ist. Deshalb aktiv
    # warten, bis alle benötigten Ports laut TCP-Check wirklich frei sind
    # (max. 10 Sekunden) -- statt blind sofort neu zu versuchen.
    $portsWaitDeadline = 10
    $portsWaited = 0
    while ($portsWaited -lt $portsWaitDeadline) {
        $stillBusy = $false
        foreach ($entry in $PortsToCheck) {
            if (Test-PortInUse -Port $entry.Port) {
                $stillBusy = $true
                break
            }
        }
        if (-not $stillBusy) { break }
        Start-Sleep -Seconds 1
        $portsWaited++
    }

    $composeExit = Invoke-ComposeUp -LogPath $composeLog
    $composeOutput = Get-ComposeLogText -LogPath $composeLog
    Write-Line ''
} elseif ($composeExit -ne 0 -and $composeOutput -match 'lease does not exist|unable to lease content') {
    # Bekannter BuildKit/containerd-Aussetzer: der Build-Content-Store ist
    # durcheinander (meist nach vielen Builds hintereinander oder einem
    # abgebrochenen vorherigen Build). "docker builder prune" räumt nur den
    # Cache auf -- Container, Volumes und der Vault bleiben unangetastet.
    Write-Warn 'Der Docker-Build-Cache scheint durcheinander zu sein (bekannter BuildKit-Aussetzer).'
    Write-Line '    Wir räumen den Cache automatisch auf und versuchen es genau einmal erneut.'
    Write-Line '    Der nächste Build lädt dadurch ein paar Layer neu — das dauert etwas länger.'
    Write-Line ''

    docker builder prune -f 2>&1 | Out-Null

    $composeExit = Invoke-ComposeUp -LogPath $composeLog
    $composeOutput = Get-ComposeLogText -LogPath $composeLog
    Write-Line ''
}

if ($composeExit -ne 0) {
    Write-Fail "Der Start ist fehlgeschlagen (docker compose Exit-Code $composeExit)."
    Write-Line ''

    # Steht in der Meldung ein konkreter Port? Dann sagen wir dem Menschen auch
    # gleich, WER ihn hält — statt ihn selbst auf die Suche zu schicken.
    $conflictPort = $null
    if ($composeOutput -match '0\.0\.0\.0:(\d+)') {
        $conflictPort = $Matches[1]
    } elseif ($composeOutput -match 'Bind for \S*?:(\d+)') {
        $conflictPort = $Matches[1]
    }

    if ($conflictPort) {
        $holderText = $null

        # Get-NetTCPConnection gibt es erst ab Windows 8 / Server 2012. Fehlt es,
        # überspringen wir diesen Weg still.
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            try {
                $conn = Get-NetTCPConnection -LocalPort ([int]$conflictPort) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($conn) {
                    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
                    if ($proc) {
                        $holderText = "$($proc.ProcessName) (PID $($conn.OwningProcess))"
                    } else {
                        $holderText = "PID $($conn.OwningProcess)"
                    }
                }
            } catch {
                $holderText = $null
            }
        }

        # Vielleicht hält ein ganz anderes Docker-Projekt den Port.
        if (-not $holderText) {
            $dockerHolder = (docker ps --filter "publish=$conflictPort" --format '{{.Names}}  ({{.Image}})' 2>$null)
            if ($dockerHolder) {
                $holderText = @($dockerHolder)[0]
            }
        }

        Write-Line "    Port $conflictPort ist belegt — auch nach dem automatischen Aufräumen."
        if ($holderText) {
            Write-Line ''
            Write-Line "    Belegt von: $holderText"
            Write-Line ''
            Write-Line "    Bitte dieses Programm beenden (oder in $ComposeFile einen anderen"
            Write-Line '    Port eintragen) und dieses Script erneut aufrufen.'
        } else {
            Write-Line '    Wer den Port hält, war hier nicht zu ermitteln.'
            Write-Line '    Mehr Details bekommst du in einer PowerShell mit Administrator-Rechten:'
            Write-Line ''
            Write-Host "        Get-NetTCPConnection -LocalPort $conflictPort | Select-Object OwningProcess" -ForegroundColor White
        }
        Write-Line ''
    }

    Write-Line '    Die Fehlermeldung von Docker steht direkt darüber. Häufige Ursachen:'
    Write-Line '      - Ein Port ist wirklich belegt (siehe Warnungen oben)'
    Write-Line '      - Kein Speicherplatz mehr — aufräumen mit: docker system prune'
    Write-Line '      - Keine Internetverbindung zum Herunterladen der Images'
    Write-Line ''
    Write-Line "    Logs ansehen:  docker compose -f $ComposeFile logs"
    Write-Line ''
    Remove-Item -Path $composeLog -Force -ErrorAction SilentlyContinue
    exit 4
}

Remove-Item -Path $composeLog -Force -ErrorAction SilentlyContinue
Write-Ok 'Container gestartet.'

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 8 — Warten, bis Web-UI UND API bereit sind
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

Write-Step "Schritt 8/10 — Warten, bis Web-UI und API bereit sind (max. $MaxWaitSeconds Sekunden)"

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

# Hier zählt — anders als oben — der HTTP-Status: /api/setup/status liefert erst
# dann eine 200, wenn der Server hochgefahren ist und die Datenbank erreicht.
# Genau diese Antwort braucht die Web-UI, um den Setup-Wizard zu zeigen.
function Test-ApiReady {
    try {
        $response = Invoke-WebRequest -Uri "$ApiUrl/api/setup/status" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        return ($response.StatusCode -eq 200)
    } catch {
        # Anders als bei der PWA gilt hier NICHT "irgendeine Antwort reicht":
        # ein 4xx/5xx heißt, der Server ist noch nicht so weit.
        return $false
    }
}

$stackReady = $false
$attempts = [int]($MaxWaitSeconds / $PollIntervalSeconds)
Write-Host '    ' -NoNewline

for ($i = 1; $i -le $attempts; $i++) {
    if ((Test-PwaReachable) -and (Test-ApiReady)) {
        $stackReady = $true
        break
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds $PollIntervalSeconds
}
Write-Line ''

if ($stackReady) {
    Write-Ok "Web-UI und API antworten ($PwaUrl)"
} else {
    Write-Warn "Web-UI und API haben nach $MaxWaitSeconds Sekunden noch nicht beide geantwortet."
    Write-Line '    Das ist beim allerersten Start normal (Images bauen dauert).'
    Write-Line '    Wir öffnen den Browser trotzdem — lade die Seite in ein bis zwei'
    Write-Line '    Minuten einfach neu.'
    Write-Line "    Status ansehen:  docker compose -f $ComposeFile ps"
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 9 — Browser öffnen
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 9/10 — Browser öffnen'

try {
    # -ErrorAction Stop, damit ein Fehlschlag wirklich im catch-Block landet.
    Start-Process $PwaUrl -ErrorAction Stop | Out-Null
    Write-Ok 'Browser wird geöffnet.'
} catch {
    Write-Warn 'Browser konnte nicht automatisch geöffnet werden — bitte die Adresse von Hand öffnen:'
    Write-Line "    $PwaUrl"
}

# ─────────────────────────────────────────────────────────────────────────────
# Schritt 10 — Wie geht es weiter?
# ─────────────────────────────────────────────────────────────────────────────

Write-Step 'Schritt 10/10 — Fertig'

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
