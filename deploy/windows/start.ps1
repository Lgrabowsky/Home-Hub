# Home Hub auf einem Windows-PC starten.
#
#   Demo starten.cmd       → alle Geräte simuliert, zum Ausprobieren
#   Home Hub starten.cmd   → echte Geräte (in der App unter „Geräte & Dienste“ einrichten)
#
# Fehlt Node.js oder ffmpeg, installiert das Skript beides mit winget (einmalig).

param([switch]$Demo)

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

# Tailscale (optional): gibt dem Hub eine https-Adresse – die braucht die Android-App.
$tailscaleUrl = $null
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if ($tailscale) {
  try {
    $status = & tailscale status --json | ConvertFrom-Json
    if ($status.BackendState -eq 'Running' -and $status.Self.DNSName) {
      $name = $status.Self.DNSName.TrimEnd('.')
      & tailscale serve --bg 8080 | Out-Null
      $tailscaleUrl = "https://$name"
      $env:HUB_PUBLIC_URL = $tailscaleUrl
    }
  } catch {
    Say "Tailscale ist installiert, aber „tailscale serve“ hat nicht geklappt: $($_.Exception.Message)" Yellow
  }
}

# --- Adressen für das Handy ------------------------------------------------------------------------------
$addresses = @()
try {
  $addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.IPAddress -notlike '100.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
    Select-Object -ExpandProperty IPAddress
} catch { }

Say ''
Say '==============================================================' Green
if ($Demo) { Say '  Home Hub – Demo (alle Geräte sind simuliert)' Green } else { Say '  Home Hub' Green }
Say '==============================================================' Green
Say ''
Say 'Vom Handy im selben WLAN, im Browser (Chrome) öffnen:' White
foreach ($ip in $addresses) { Say "    http://${ip}:8080" Cyan }
if (-not $addresses) { Say '    http://<IP-Adresse dieses PCs>:8080' Cyan }
Say ''
if ($tailscaleUrl) {
  Say 'Mit der Android-App (und von unterwegs) diese Adresse eintragen:' White
  Say "    $tailscaleUrl" Cyan
} else {
  Say 'Für die Android-App braucht der Hub eine https-Adresse: Tailscale auf PC und Handy' DarkGray
  Say 'installieren und anmelden, dann dieses Fenster schließen und neu starten (siehe LIESMICH).' DarkGray
}
Say ''
Say 'Fragt Windows nach der Firewall: „Private Netzwerke“ zulassen.' DarkGray
Say 'Beim ersten Start steht unten der Einrichtungscode für das erste Konto.' DarkGray
Say 'Beenden: dieses Fenster schließen oder Strg+C.' DarkGray
Say ''

& node (Join-Path $Root 'app\hub\dist\index.js')
$code = $LASTEXITCODE
if ($code -ne 0) {
  Say ''
  Say "Der Hub wurde mit Code $code beendet. Läuft er vielleicht schon in einem anderen Fenster (Port 8080 belegt)?" Red
  Read-Host 'Enter zum Beenden'
}
