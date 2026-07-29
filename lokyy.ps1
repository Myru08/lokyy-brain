# lokyy.ps1 — Lokyy Brain im Alltag steuern (Windows).
#
# install.ps1 ist der EINMALIGE Einstieg (Docker installieren, Images bauen).
# Dieses Script hier ist der Alltag DANACH: starten, anhalten, nachschauen.
# Es setzt voraus, dass install.ps1 schon einmal erfolgreich durchgelaufen ist —
# es installiert selbst kein Docker und baut auch keine Images neu.
#
# Die fünf Befehle:
#   start     Stack starten, auf die Web-UI warten, Browser öffnen
#   stop      Stack anhalten (Container bleiben erhalten, nächster Start ist schnell)
#   restart   Container neu starten
#   status    Kurzer Überblick: Container + Erreichbarkeit (nur lesend)
#   doctor    Ausführliche Diagnose (nur lesend — ändert NICHTS von selbst)
#
# Aufruf in PowerShell (im Projekt-Ordner):
#   .\lokyy.ps1 start
#
# Falls Windows das Ausführen von Scripten blockiert ("... kann nicht geladen
# werden, da die Ausführung von Skripts auf diesem System deaktiviert ist"),
# hilft dieser Aufruf — er gilt nur für dieses eine Fenster:
#   powershell -ExecutionPolicy Bypass -File .\lokyy.ps1 start
#
# Gut zu wissen: alle Dienste in docker-compose.local.yml haben
# "restart: unless-stopped". Nach einem Neustart des Rechners fährt der Stack
# also von allein wieder hoch, sobald Docker Desktop selbst läuft —
# .\lokyy.ps1 start brauchst du dafür nicht.
#
# Exit-Codes (wie in install.ps1):
#   0  alles gut
#   1  Aufruf ohne (oder mit unbekanntem) Befehl — oder Docker fehlt ganz
#   2  Docker-Daemon läuft nicht
#   3  "docker compose" (v2) fehlt
#   4  die Aktion ist fehlgeschlagen (start/stop/restart) bzw. doctor hat
#      Probleme gefunden

param([string]$Command = '')

# Fehler von PowerShell-Cmdlets sollen das Script nicht sofort abbrechen —
# wir prüfen jeden Schritt selbst und geben dazu eine verständliche Meldung aus.
# (Exit-Codes externer Programme wie docker landen ohnehin in $LASTEXITCODE.)
$ErrorActionPreference = 'Continue'

# ─────────────────────────────────────────────────────────────────────────────
# Konfiguration — dieselben Werte wie in install.ps1
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

# Wie lange warten wir maximal, bis die Web-UI antwortet?
$MaxWaitSeconds      = 90
$PollIntervalSeconds = 2

# Der einmalige Init-Container: lädt das Embedding-Modell in Ollama und beendet
# sich danach. "Exited (0)" ist bei ihm der NORMALZUSTAND, kein Fehler.
$OneShotService = 'ollama-init'

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

# ─────────────────────────────────────────────────────────────────────────────
# Gemeinsame Helfer
# ─────────────────────────────────────────────────────────────────────────────

function Show-Usage {
    Write-Line ''
    Write-Host 'lokyy.ps1 — Lokyy Brain im Alltag steuern' -ForegroundColor White
    Write-Line ''
    Write-Line '  Aufruf:  .\lokyy.ps1 <Befehl>'
    Write-Line ''
    Write-Line '    start     Stack starten, auf die Web-UI warten, Browser öffnen'
    Write-Line '    stop      Stack anhalten (Container bleiben erhalten)'
    Write-Line '    restart   Container neu starten'
    Write-Line '    status    Überblick: Container + Erreichbarkeit (nur lesend)'
    Write-Line '    doctor    Ausführliche Diagnose (nur lesend)'
    Write-Line ''
    Write-Line '  Die Erst-Installation macht install.ps1 — auch neue Images baut nur die.'
    Write-Line ''
}

# Ist docker überhaupt da? Wenn nicht: klar sagen und raus — dieses Script
# installiert bewusst nichts, das ist die Aufgabe von install.ps1.
function Assert-DockerCli {
    if (Get-Command docker -ErrorAction SilentlyContinue) {
        return
    }
    Write-Fail 'Docker ist nicht installiert — führe zuerst install.ps1 aus.'
    exit 1
}

# Läuft der Docker-Daemon wirklich? Das ist der häufigste Stolperstein:
# der Befehl "docker" existiert, aber dahinter antwortet niemand.
function Assert-DockerDaemon {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        return
    }

    Write-Fail 'Docker ist installiert, aber der Docker-Daemon antwortet nicht.'
    Write-Line ''
    Write-Line '  Bitte starte Docker Desktop (Startmenü) und warte, bis das Wal-Symbol'
    Write-Line '  unten rechts in der Taskleiste ruhig steht bzw. "Engine running" meldet.'
    Write-Line '  Beim ersten Start nach dem Hochfahren dauert das oft eine Minute.'
    Write-Line ''
    Write-Line '  Danach diesen Befehl einfach noch einmal aufrufen.'
    Write-Line ''
    exit 2
}

function Assert-ComposeFile {
    if (Test-Path $ComposeFile) {
        return
    }
    Write-Fail "Die Datei $ComposeFile liegt nicht im Projekt-Ordner."
    Write-Line '    Bitte prüfe, ob das Repo vollständig heruntergeladen wurde.'
    exit 4
}

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

# Antwortet eine unserer Adressen? Uns interessiert NUR, ob eine Verbindung
# zustande kommt — welcher HTTP-Status zurückkommt, ist hier egal.
function Test-UrlReachable {
    param([string]$Url)

    try {
        # -ErrorAction Stop ist hier PFLICHT: ohne das ist ein fehlgeschlagener
        # Verbindungsversuch in Windows PowerShell 5.1 nur ein "nicht
        # abbrechender" Fehler — der catch-Block würde nicht greifen und die
        # Funktion würde fälschlicherweise "erreichbar" melden.
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
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

# Best-effort-Diagnose: WER hält einen Port? Gibt einen Text zurück oder $null.
function Get-PortHolder {
    param([int]$Port)

    $holderText = $null

    # Get-NetTCPConnection gibt es erst ab Windows 8 / Server 2012. Fehlt es,
    # überspringen wir diesen Weg still.
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        try {
            $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
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
        $dockerHolder = (docker ps --filter "publish=$Port" --format '{{.Names}}  ({{.Image}})' 2>$null)
        if ($dockerHolder) {
            $holderText = @($dockerHolder)[0]
        }
    }

    return $holderText
}

# Gibt aus, wer einen Port hält — oder wie man es mit Administrator-Rechten
# herausfindet. Wird von start (Fehlerfall) und doctor gleichermaßen benutzt.
function Show-PortHolder {
    param([int]$Port)

    $holderText = Get-PortHolder -Port $Port
    if ($holderText) {
        Write-Line "        Belegt von: $holderText"
    } else {
        Write-Line '        Wer den Port hält, war hier nicht zu ermitteln.'
        Write-Line '        Mehr Details in einer PowerShell mit Administrator-Rechten:'
        Write-Host "        Get-NetTCPConnection -LocalPort $Port | Select-Object OwningProcess" -ForegroundColor White
    }
}

# Wartet, bis die Web-UI antwortet. Jeder Punkt = ein Versuch.
function Wait-PwaReady {
    $attempts = [int]($MaxWaitSeconds / $PollIntervalSeconds)
    Write-Host '    ' -NoNewline

    for ($i = 1; $i -le $attempts; $i++) {
        if (Test-UrlReachable -Url $PwaUrl) {
            Write-Line ''
            return $true
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds $PollIntervalSeconds
    }
    Write-Line ''
    return $false
}

function Show-Endpoints {
    Write-Line ''
    Write-Line "  Web-UI (hier geht es los)   $PwaUrl"
    Write-Line "  Server-API                  $ApiUrl"
    Write-Line "  MCP-Endpoint                $McpUrl"
    Write-Line "  Forgejo (optional)          $ForgejoUrl"
    Write-Line ''
    Write-Host 'Nützliche Befehle' -ForegroundColor White
    Write-Line '  Status:    .\lokyy.ps1 status'
    Write-Line '  Diagnose:  .\lokyy.ps1 doctor'
    Write-Line "  Logs:      docker compose -f $ComposeFile logs -f"
    Write-Line '  Anhalten:  .\lokyy.ps1 stop'
    Write-Line ''
}

# Gemeinsamer Abschluss von start und restart: warten, Browser, Zusammenfassung.
function Complete-WithPwa {
    Write-Step "Warten, bis die Web-UI erreichbar ist (max. $MaxWaitSeconds Sekunden)"

    if (Wait-PwaReady) {
        Write-Ok "Web-UI antwortet unter $PwaUrl"
    } else {
        Write-Warn "Die Web-UI hat nach $MaxWaitSeconds Sekunden noch nicht geantwortet."
        Write-Line '    Wir öffnen den Browser trotzdem — lade die Seite in ein bis zwei'
        Write-Line '    Minuten einfach neu.'
        Write-Line '    Status ansehen:  .\lokyy.ps1 status'
    }

    Write-Step 'Browser öffnen'
    try {
        # -ErrorAction Stop, damit ein Fehlschlag wirklich im catch-Block landet.
        Start-Process $PwaUrl -ErrorAction Stop | Out-Null
        Write-Ok 'Browser wird geöffnet.'
    } catch {
        Write-Warn 'Browser konnte nicht automatisch geöffnet werden — bitte die Adresse von Hand öffnen:'
        Write-Line "    $PwaUrl"
    }

    Write-Line ''
    Write-Host 'Lokyy Brain läuft.' -ForegroundColor Green
    Show-Endpoints
}

# ─────────────────────────────────────────────────────────────────────────────
# start — Stack hochfahren
#
# Bewusst OHNE --build: das ist der schnelle Alltags-Start. Wer nach einem
# Update des Codes wirklich neu bauen muss, ruft install.ps1 auf — dort ist
# --build zu Hause, und nur dort.
#
# Zwei bekannte, selbstheilbare Fehlerbilder fangen wir wie install.ps1 ab:
# ein Port-Rest aus einem früheren Lauf und ein durcheinandergeratener
# BuildKit-Content-Store. Beides kann auch ohne --build auftreten.
# ─────────────────────────────────────────────────────────────────────────────

# Startet den Stack. Die Ausgabe brauchen wir zweimal: live auf dem Bildschirm
# UND als Datei, um sie im Fehlerfall auswerten zu können. Beides zugleich
# leistet Tee-Object. Die Feinheiten (2>&1, ForEach-Object, Out-Host,
# $LASTEXITCODE) sind identisch zu install.ps1 — dort stehen sie ausführlich
# begründet.
function Invoke-ComposeUp {
    param([string]$LogPath)

    docker compose -f $ComposeFile up -d 2>&1 |
        ForEach-Object { "$_" } |
        Tee-Object -FilePath $LogPath |
        Out-Host
    return $LASTEXITCODE
}

# Liest das Protokoll als einen einzigen Text zurück.
function Get-ComposeLogText {
    param([string]$LogPath)

    if (-not (Test-Path $LogPath)) { return '' }
    $text = Get-Content -Path $LogPath -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { return '' }
    return [string]$text
}

function Invoke-Start {
    Assert-DockerCli
    Assert-DockerDaemon
    Assert-ComposeFile

    Write-Step 'Lokyy Brain starten'

    $composeLog = Join-Path $env:TEMP "lokyy-compose-$PID.log"

    Write-Line ''
    $composeExit = Invoke-ComposeUp -LogPath $composeLog
    $composeOutput = Get-ComposeLogText -LogPath $composeLog
    Write-Line ''

    # Zwei bekannte, selbstheilbare Fehlerbilder. Alles andere (kein Internet,
    # kein Speicherplatz) wird NICHT wiederholt.
    if ($composeExit -ne 0 -and $composeOutput -match 'port is already allocated') {
        Write-Warn 'Ein Port ist noch belegt — das sieht nach einem Rest aus einem früheren Start aus.'
        Write-Line '    Wir räumen den alten Stack automatisch ab und versuchen es genau einmal erneut.'
        Write-Line ''

        # Aufräumen ist ein Versuch, keine Bedingung: Ausgabe unterdrücken,
        # Exit-Code bewusst ignorieren.
        docker compose -f $ComposeFile down --remove-orphans 2>&1 | Out-Null

        # "down" kehrt zurück, sobald Docker die Container entfernt hat -- der
        # Host-Port wird dabei aber nicht IMMER synchron wieder freigegeben.
        # Deshalb aktiv warten, bis alle benötigten Ports laut TCP-Check
        # wirklich frei sind (max. 10 Sekunden).
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
        # durcheinander. "docker builder prune" räumt nur den Cache auf --
        # Container, Volumes und der Vault bleiben unangetastet.
        Write-Warn 'Der Docker-Build-Cache scheint durcheinander zu sein (bekannter BuildKit-Aussetzer).'
        Write-Line '    Wir räumen den Cache automatisch auf und versuchen es genau einmal erneut.'
        Write-Line ''

        docker builder prune -f 2>&1 | Out-Null

        $composeExit = Invoke-ComposeUp -LogPath $composeLog
        $composeOutput = Get-ComposeLogText -LogPath $composeLog
        Write-Line ''
    }

    if ($composeExit -ne 0) {
        Write-Fail "Der Start ist fehlgeschlagen (docker compose Exit-Code $composeExit)."
        Write-Line ''

        # Steht in der Meldung ein konkreter Port? Dann sagen wir auch gleich,
        # WER ihn hält — statt den Menschen selbst auf die Suche zu schicken.
        $conflictPort = $null
        if ($composeOutput -match '0\.0\.0\.0:(\d+)') {
            $conflictPort = $Matches[1]
        } elseif ($composeOutput -match 'Bind for \S*?:(\d+)') {
            $conflictPort = $Matches[1]
        }

        if ($conflictPort) {
            Write-Line "    Port $conflictPort ist belegt — auch nach dem automatischen Aufräumen."
            Show-PortHolder -Port ([int]$conflictPort)
            Write-Line ''
            Write-Line "    Bitte dieses Programm beenden (oder in $ComposeFile einen anderen"
            Write-Line '    Port eintragen) und .\lokyy.ps1 start erneut aufrufen.'
            Write-Line ''
        }

        Write-Line '    Die Fehlermeldung von Docker steht direkt darüber.'
        Write-Line '    Mehr Details:  .\lokyy.ps1 doctor'
        Write-Line "    Logs ansehen:  docker compose -f $ComposeFile logs"
        Write-Line ''
        Remove-Item -Path $composeLog -Force -ErrorAction SilentlyContinue
        exit 4
    }

    Remove-Item -Path $composeLog -Force -ErrorAction SilentlyContinue
    Write-Ok 'Container gestartet.'

    Complete-WithPwa
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

function Invoke-Stop {
    Assert-DockerCli
    Assert-DockerDaemon
    Assert-ComposeFile

    Write-Step 'Lokyy Brain anhalten'
    Write-Line ''

    docker compose -f $ComposeFile stop 2>&1 | ForEach-Object { "$_" } | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Line ''
        Write-Fail 'Das Anhalten ist fehlgeschlagen — die Meldung von Docker steht darüber.'
        exit 4
    }

    Write-Line ''
    Write-Ok 'Lokyy Brain ist angehalten. Weiter geht es mit .\lokyy.ps1 start'
    Write-Line ''
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# restart — Container durchstarten (z. B. nach einer Änderung an der Env)
# ─────────────────────────────────────────────────────────────────────────────

function Invoke-Restart {
    Assert-DockerCli
    Assert-DockerDaemon
    Assert-ComposeFile

    Write-Step 'Lokyy Brain neu starten'
    Write-Line ''

    docker compose -f $ComposeFile restart 2>&1 | ForEach-Object { "$_" } | Out-Host
    if ($LASTEXITCODE -ne 0) {
        Write-Line ''
        Write-Fail 'Der Neustart ist fehlgeschlagen — die Meldung von Docker steht darüber.'
        Write-Line '    Mehr Details:  .\lokyy.ps1 doctor'
        exit 4
    }

    Write-Line ''
    Write-Ok 'Container neu gestartet.'

    Complete-WithPwa
    exit 0
}

# ─────────────────────────────────────────────────────────────────────────────
# status — schneller Überblick, rein lesend
# ─────────────────────────────────────────────────────────────────────────────

# Eine Adresse prüfen und das Ergebnis als Zeile ausgeben.
function Show-Endpoint {
    param([string]$Label, [string]$Url)

    if (Test-UrlReachable -Url $Url) {
        Write-Ok "$Label  $Url"
    } else {
        Write-Warn "$Label  $Url  — antwortet nicht"
    }
}

function Invoke-Status {
    Assert-DockerCli
    Assert-DockerDaemon
    Assert-ComposeFile

    Write-Step 'Container'
    Write-Line ''
    # Bewusst "ps -a": ohne -a versteckt Compose beendete Container — und damit
    # ausgerechnet den einmaligen Init-Container, über den man sonst rätselt.
    docker compose -f $ComposeFile ps -a 2>&1 | ForEach-Object { "$_" } | Out-Host
    Write-Line ''
    Write-Line "    Hinweis: $OneShotService steht auf `"Exited (0)`" — das ist der"
    Write-Line '    Normalzustand. Dieser Container lädt einmalig das Embedding-Modell'
    Write-Line '    und beendet sich danach; er muss NICHT laufen.'
    Write-Line ''

    Write-Step 'Erreichbarkeit'
    Show-Endpoint -Label 'Web-UI       ' -Url $PwaUrl
    Show-Endpoint -Label 'Server-API   ' -Url $ApiUrl
    Show-Endpoint -Label 'MCP-Endpoint ' -Url $McpUrl
    Write-Line ''
    Write-Line '    (Der MCP-Endpoint antwortet ohne Bearer-Token mit einem Fehler —'
    Write-Line '     hier zählt nur, DASS er antwortet.)'
    Write-Line ''
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

function Invoke-Doctor {
    Assert-DockerCli

    Write-Line ''
    Write-Host 'Lokyy Brain — Diagnose (nur lesend, es wird nichts verändert)' -ForegroundColor White
    Write-Line ''

    # Gefundene Probleme sammeln wir ein und geben sie am Ende gebündelt aus —
    # jeweils mit dem Befehl, der als Nächstes hilft.
    $findings = @()

    # ── 1) Läuft der Docker-Daemon? ────────────────────────────────────────────
    Write-Step '1/5 — Docker-Daemon'
    Assert-DockerDaemon
    Write-Ok "Docker-Daemon läuft: $(docker --version 2>$null)"

    # ── 2) Compose-Plugin v2 vorhanden? ────────────────────────────────────────
    Write-Step '2/5 — Compose-Plugin (docker compose v2)'
    # Erst die komplette Ausgabe einsammeln, dann auswerten: würden wir direkt in
    # "Select-Object -First 1" pipen, könnte PowerShell das Programm vorzeitig
    # beenden und $LASTEXITCODE wäre nicht mehr verlässlich.
    $composeVersionOutput = (docker compose version 2>&1)
    $composeVersionExit = $LASTEXITCODE
    if ($composeVersionExit -ne 0) {
        Write-Fail 'Der Unterbefehl "docker compose" ist nicht verfügbar.'
        Write-Line '    Lokyy Brain braucht Compose v2 — also "docker compose" (mit Leerzeichen),'
        Write-Line '    nicht das alte "docker-compose" (mit Bindestrich).'
        Write-Line ''
        exit 3
    }
    Write-Ok "Compose gefunden: $(@($composeVersionOutput)[0])"

    Assert-ComposeFile

    # ── 3) Speicherplatz — Dockers eigenen Bericht durchreichen ────────────────
    # Bewusst ohne eigene Schwellwerte: was "zu wenig" ist, hängt vom Rechner ab.
    # Die Zahlen von Docker sind aussagekräftiger als jede geratene Grenze.
    Write-Step '3/5 — Speicherplatz (Bericht von Docker)'
    Write-Line ''
    docker system df 2>&1 | ForEach-Object { "$_" } | Out-Host
    Write-Line ''
    Write-Line '    Zum Aufräumen (löscht ungenutzte Images/Cache):  docker system prune'
    Write-Line ''

    # Läuft unser Stack gerade? Das entscheidet darüber, ob ein belegter Port
    # normal ist (unsere eigenen Container) oder ein echter Konflikt.
    # Bewusst über .Count statt über einen [bool]-Cast: eine leere Ausgabe kommt
    # in Windows PowerShell 5.1 mal als $null und mal als leeres Array zurück —
    # gezähltes Array ist in beiden Fällen eindeutig.
    $runningIds = @(docker compose -f $ComposeFile ps -q --status running 2>$null | Where-Object { $_ })
    $stackRunning = ($runningIds.Count -gt 0)

    # ── 4) Ports ───────────────────────────────────────────────────────────────
    Write-Step '4/5 — Ports (8787, 8095, 8788, 8790)'
    foreach ($entry in $PortsToCheck) {
        if (Test-PortInUse -Port $entry.Port) {
            if ($stackRunning) {
                Write-Ok "Port $($entry.Port) ($($entry.Label)) ist belegt — vermutlich von Lokyy Brain selbst."
            } else {
                Write-Warn "Port $($entry.Port) ($($entry.Label)) ist belegt, obwohl kein Lokyy-Container läuft."
                Show-PortHolder -Port $entry.Port
                $findings += "Port $($entry.Port) ($($entry.Label)) ist von einem fremden Programm belegt.`n      Erst prüfen, wer das ist (siehe oben), dann:  docker compose -f $ComposeFile down --remove-orphans; .\lokyy.ps1 start"
            }
        } else {
            Write-Ok "Port $($entry.Port) ($($entry.Label)) ist frei."
        }
    }

    # ── 5) Container ───────────────────────────────────────────────────────────
    Write-Step '5/5 — Container'
    Write-Line ''
    docker compose -f $ComposeFile ps -a 2>&1 | ForEach-Object { "$_" } | Out-Host
    Write-Line ''

    # Für die Bewertung fragen wir dieselben Daten noch einmal maschinenlesbar ab.
    # Ältere Compose-Versionen kennen keine Go-Templates — dann verzichten wir
    # eben auf die automatische Bewertung, statt hier mit einem Fehler abzubrechen.
    $stateLines = @(docker compose -f $ComposeFile ps -a --format '{{.Service}}|{{.State}}|{{.Health}}' 2>$null | Where-Object { $_ })

    if ($stateLines.Count -eq 0) {
        if (-not $stackRunning) {
            Write-Warn 'Es läuft aktuell kein einziger Lokyy-Container.'
            $findings += "Der Stack läuft nicht.`n      Starten mit:  .\lokyy.ps1 start"
        } else {
            Write-Warn 'Die Container-Zustände konnten nicht ausgewertet werden (sehr alte Compose-Version?).'
            Write-Line '    Die Tabelle oben stimmt trotzdem — bitte selbst darüberschauen.'
        }
    } else {
        foreach ($line in $stateLines) {
            $parts   = "$line" -split '\|'
            $service = $parts[0]
            $state   = if ($parts.Count -gt 1) { $parts[1] } else { '' }
            $health  = if ($parts.Count -gt 2) { $parts[2] } else { '' }

            if (-not $service) { continue }

            if ($service -eq $OneShotService -and $state -eq 'exited') {
                Write-Ok "${service}: einmalig gelaufen und beendet — genau so soll es sein."
                continue
            }

            switch ($state) {
                'running' {
                    if ($health -eq 'unhealthy') {
                        Write-Warn "${service}: läuft, meldet sich aber als unhealthy."
                        $findings += "$service ist unhealthy.`n      Logs ansehen:  docker compose -f $ComposeFile logs $service"
                    } elseif ($health -eq 'starting') {
                        Write-Warn "${service}: fährt noch hoch (Healthcheck läuft) — in einer Minute nochmal schauen."
                    } else {
                        Write-Ok "${service}: läuft."
                    }
                }
                'restarting' {
                    Write-Warn "${service}: startet immer wieder neu — das ist eine Absturz-Schleife."
                    $findings += "$service hängt in einer Neustart-Schleife.`n      Logs ansehen:  docker compose -f $ComposeFile logs $service"
                }
                { $_ -eq 'exited' -or $_ -eq 'dead' } {
                    Write-Warn "${service}: ist beendet (Zustand: $state)."
                    $findings += "$service läuft nicht mehr.`n      Logs ansehen:  docker compose -f $ComposeFile logs $service"
                }
                default {
                    Write-Warn "${service}: unbekannter Zustand `"$state`"."
                    $findings += "$service hat einen unerwarteten Zustand ($state).`n      Logs ansehen:  docker compose -f $ComposeFile logs $service"
                }
            }
        }
    }

    # ── Zusammenfassung ────────────────────────────────────────────────────────
    Write-Line ''
    Write-Step 'Zusammenfassung'
    Write-Line ''

    if (@($findings).Count -eq 0) {
        Write-Host '  Alles sieht gut aus.' -ForegroundColor Green
        Write-Line ''
        exit 0
    }

    Write-Host '  Diese Punkte sind aufgefallen:' -ForegroundColor Yellow
    Write-Line ''
    foreach ($finding in $findings) {
        Write-Line "    - $finding"
    }
    Write-Line ''
    Write-Line '  doctor ändert von sich aus nichts — die Befehle oben führst du selbst aus.'
    Write-Line ''
    exit 4
}

# ─────────────────────────────────────────────────────────────────────────────
# Befehl auswählen
# ─────────────────────────────────────────────────────────────────────────────

switch ($Command) {
    'start'   { Invoke-Start }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'doctor'  { Invoke-Doctor }
    default {
        Show-Usage
        exit 1
    }
}
