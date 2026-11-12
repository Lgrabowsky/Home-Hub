# Home Hub auf einem Windows-PC starten.
#
#   Demo starten.cmd       → alle Geräte simuliert, zum Ausprobieren
#   Home Hub starten.cmd   → echte Geräte (in der App unter „Geräte & Dienste“ einrichten)
#
# Fehlt Node.js oder ffmpeg, installiert das Skript beides mit winget (einmalig).
#
# Der Hub spricht https mit einem eigenen Zertifikat (Port 8443). Port 8080 zeigt nur die Seite, auf
# der Handys das Zertifikat einmalig installieren. -NoHttps schaltet das ab (dann alles über 8080).

param([switch]$Demo, [switch]$NoHttps)

$ErrorActionPreference = 'Stop'
# Whatever goes wrong: say it and keep the window open, instead of vanishing.
trap {
  Write-Host "Fehler: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Enter zum Beenden'
  exit 1
}
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Host.UI.RawUI.WindowTitle = if ($Demo) { 'Home Hub (Demo)' } else { 'Home Hub' }

function Say([string]$Text, [string]$Color = 'Gray') { Write-Host $Text -ForegroundColor $Color }

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-WithWinget([string]$Id, [string]$Name) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Say "$Name fehlt und winget ist nicht verfügbar. Bitte $Name selbst installieren und das Skript erneut starten." Red
    Read-Host 'Enter zum Beenden'
    exit 1
  }
  Say "$Name wird installiert (einmalig) …" Cyan
  winget install --id $Id -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}

# --- Node.js 22.13 oder neuer ---------------------------------------------------------------------
function Node-Ok {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $false }
  $version = (& node --version).TrimStart('v')
  return ([version]$version -ge [version]'22.13.0')
}
if (-not (Node-Ok)) { Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js' }
if (-not (Node-Ok)) {
  Say 'Node.js 22.13 oder neuer wird benötigt (https://nodejs.org). Bitte installieren und erneut starten.' Red
  Read-Host 'Enter zum Beenden'
  exit 1
}

# --- ffmpeg (Live-Bild der Demo, Ton der Kameras) ----------------------------------------------------
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { Install-WithWinget 'Gyan.FFmpeg' 'ffmpeg' }
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Say 'Hinweis: ffmpeg wurde nicht gefunden – die App läuft, das Live-Bild der Demo aber nicht.' Yellow
}

# Aus dem Internet geladene Dateien sperrt Windows sonst beim ersten Start.
Get-ChildItem -Path $Root -Recurse -Include *.exe, *.ps1 -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# --- Einstellungen des Hubs ----------------------------------------------------------------------------
$dataName = if ($Demo) { 'demo' } else { 'daten' }
$env:HUB_DATA_DIR = Join-Path $env:LOCALAPPDATA "HomeHub\$dataName"
$env:HUB_HOST = '0.0.0.0'
$env:HUB_PORT = '8080'
$env:HUB_WEBRTC_PORT = '8555'
$env:HUB_RTSP_PORT = '8554'
$env:HUB_LOG_LEVEL = 'warn'
$env:GO2RTC_BIN = Join-Path $Root 'bin\go2rtc.exe'
$env:FFMPEG_BIN = 'ffmpeg'
if ($Demo) { $env:HUB_DEMO = '1' } else { Remove-Item Env:HUB_DEMO -ErrorAction SilentlyContinue }

# --- Adressen für das Handy ------------------------------------------------------------------------------
$addresses = @()
try {
  $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '100.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress)
} catch { }
# Die Adresse im Heimnetz: die der Verbindung mit der Standardroute (nicht die virtueller Adapter).
$primary = $null
try {
  $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
  $primary = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1 -ExpandProperty IPAddress
} catch { }
if (-not $primary -and $addresses) { $primary = $addresses[0] }

# --- https mit eigenem Zertifikat ---------------------------------------------------------------------------
$hubJs = Join-Path $Root 'app\hub\dist\index.js'
$https = -not $NoHttps
$fingerprint = $null
if ($https) {
  $env:HUB_TLS = 'auto'
  $env:HUB_HTTPS_PORT = '8443'
  # Ein Zertifikat für Demo und echten Betrieb: Geräte müssen es nur einmal installieren.
  $env:HUB_TLS_DIR = Join-Path $env:LOCALAPPDATA 'HomeHub\zertifikat'
  $prepared = & node $hubJs --prepare-tls | ConvertFrom-Json
  $fingerprint = $prepared.fingerprint
  $caFile = $prepared.caFile
  $ca = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($caFile)
  if (-not (Test-Path ("Cert:\CurrentUser\Root\" + $ca.Thumbprint))) {
    Say ''
    Say 'Damit Browser auf diesem PC dem Hub vertrauen, wird sein Zertifikat jetzt eingetragen.' White
    Say 'Windows fragt gleich nach – bitte mit „Ja“ bestätigen. (Es gilt nur für Adressen im Heimnetz.)' White
    try {
      Import-Certificate -FilePath $caFile -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
      Say 'Zertifikat eingetragen.' Green
    } catch {
      Say "Nicht eingetragen – Browser auf diesem PC warnen dann. Nachholen: Doppelklick auf $caFile" Yellow
    }
  }
} else {
  Remove-Item Env:HUB_TLS, Env:HUB_HTTPS_PORT, Env:HUB_TLS_DIR -ErrorAction SilentlyContinue
}
$appPort = if ($https) { 8443 } else { 8080 }
$scheme = if ($https) { 'https' } else { 'http' }

# Tailscale (optional): eine https-Adresse mit öffentlich anerkanntem Zertifikat, auch von unterwegs.
$tailscaleUrl = $null
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
  try {
    $status = & tailscale status --json | ConvertFrom-Json
    if ($status.BackendState -eq 'Running' -and $status.Self.DNSName) {
      $name = $status.Self.DNSName.TrimEnd('.')
      $target = if ($https) { 'https+insecure://127.0.0.1:8443' } else { '8080' }
      & tailscale serve --bg $target | Out-Null
      $tailscaleUrl = "https://$name"
    }
  } catch {
    Say "Tailscale ist installiert, aber „tailscale serve“ hat nicht geklappt: $($_.Exception.Message)" Yellow
  }
}

# Die feste Adresse des Hubs (u. a. für die Rückleitung von Spotify): Tailscale, sonst die Heimnetz-Adresse.
if ($tailscaleUrl) { $env:HUB_PUBLIC_URL = $tailscaleUrl }
elseif ($https -and $primary) { $env:HUB_PUBLIC_URL = "https://${primary}:8443" }
else { Remove-Item Env:HUB_PUBLIC_URL -ErrorAction SilentlyContinue }

Say ''
Say '==============================================================' Green
if ($Demo) { Say '  Home Hub – Demo (alle Geräte sind simuliert)' Green } else { Say '  Home Hub' Green }
Say '==============================================================' Green
Say ''
$shown = if ($primary) { @($primary) + @($addresses | Where-Object { $_ -ne $primary }) } else { $addresses }
if ($https) {
  Say 'Handy im selben WLAN – einmalig das Zertifikat installieren, im Browser öffnen:' White
  foreach ($ip in $shown) { Say "    http://${ip}:8080" Cyan }
  if (-not $shown) { Say '    http://<IP-Adresse dieses PCs>:8080' Cyan }
  Say '  (die Seite erklärt die zwei Schritte für Android und iPhone)' DarkGray
  Say ''
  Say 'Danach im Browser und in der Android-App diese Adresse verwenden:' White
  foreach ($ip in $shown) { Say "    https://${ip}:8443" Cyan }
  Say '    Auf diesem PC: https://localhost:8443' Cyan
  Say ''
  Say "Fingerabdruck des Zertifikats (zum Vergleich auf dem Handy):" DarkGray
  Say "    $fingerprint" DarkGray
} else {
  Say 'Vom Handy im selben WLAN, im Browser öffnen:' White
  foreach ($ip in $shown) { Say "    http://${ip}:8080" Cyan }
  if (-not $shown) { Say '    http://<IP-Adresse dieses PCs>:8080' Cyan }
}
Say ''
if ($tailscaleUrl) {
  Say 'Über Tailscale (auch von unterwegs, ohne Zertifikat-Installation):' White
  Say "    $tailscaleUrl" Cyan
  Say ''
}
if ($env:HUB_PUBLIC_URL) {
  Say 'Spotify: in deiner Spotify-App (developer.spotify.com) als Redirect URI eintragen:' White
  Say "    $($env:HUB_PUBLIC_URL)/api/spotify/callback" Cyan
  Say '  Tipp: dem PC im Router eine feste IP-Adresse geben, sonst ändert sich diese Adresse.' DarkGray
  Say ''
}
Say 'Fragt Windows nach der Firewall: „Private Netzwerke“ zulassen.' DarkGray
Say 'Beim ersten Start steht unten der Einrichtungscode für das erste Konto.' DarkGray
Say 'Beenden: dieses Fenster schließen oder Strg+C.' DarkGray
Say ''

& node $hubJs
$code = $LASTEXITCODE
if ($code -ne 0) {
  Say ''
  Say "Der Hub wurde mit Code $code beendet. Läuft er vielleicht schon in einem anderen Fenster (Port 8080 oder 8443 belegt)?" Red
  Read-Host 'Enter zum Beenden'
}
