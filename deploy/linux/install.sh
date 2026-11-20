#!/usr/bin/env bash
# Home Hub – Einrichtung auf einem Linux-Rechner (Debian 12/13, Ubuntu 22.04+, Raspberry Pi OS 64-Bit):
# eine virtuelle Maschine, ein Mini-PC oder ein Raspberry Pi.
#
#   wget -O hub.sh https://raw.githubusercontent.com/lgrabowsky/home-hub/HEAD/deploy/linux/install.sh
#   sudo bash hub.sh
#
# Das Skript
#   1. installiert Docker, Tailscale und automatische Sicherheitsupdates,
#   2. meldet den Rechner bei Tailscale an (Link bzw. QR-Code fürs Handy),
#   3. schaltet https über Tailscale ein (echtes Zertifikat, nichts wird ins Internet geöffnet),
#   4. holt den Hub als fertiges Abbild und startet ihn – auch nach jedem Neustart von selbst,
#   5. zeigt die Adresse und den Einrichtungscode.
#
# Erneut ausgeführt aktualisiert es den Hub (neues Abbild, neuer Stand der Konfiguration);
# Daten und Einstellungen bleiben erhalten. Anleitung: docs/VIRTUELLE-MASCHINE.md

set -euo pipefail

REPO_URL="${HUB_REPO_URL:-https://github.com/lgrabowsky/home-hub.git}"
BRANCH="${HUB_BRANCH:-}"
DIR="${HUB_DIR:-/opt/home-hub}"
TS_HOSTNAME="${HUB_TS_HOSTNAME:-homehub}"

bold=$'\033[1m' red=$'\033[31m' green=$'\033[32m' reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$reset"; }
note() { printf '    %s\n' "$*"; }
fail() {
  printf '\n%sFehler: %s%s\n' "$red" "$*" "$reset" >&2
  exit 1
}

# Alles steht in main(): bash liest so das ganze Skript, bevor es läuft – "git pull" darf es
# beim Aktualisieren also gefahrlos ersetzen.
main() {
  # --- Voraussetzungen ---------------------------------------------------------------------------

  [ "$(id -u)" -eq 0 ] || fail "Bitte mit sudo starten:  sudo bash $0"
  [ -r /etc/os-release ] || fail "Unbekanntes System (keine /etc/os-release)."
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    debian | ubuntu) ;;
    *) fail "Dieses Skript ist für Debian, Ubuntu und Raspberry Pi OS. Gefunden: ${PRETTY_NAME:-unbekannt}." ;;
  esac
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in
    amd64 | arm64) ;;
    *) fail "Nur 64-Bit-Systeme (amd64, arm64) werden unterstützt. Gefunden: $ARCH." ;;
  esac
  CODENAME="${VERSION_CODENAME:-}"
  [ -n "$CODENAME" ] || fail "Die Version des Systems ist unbekannt (VERSION_CODENAME fehlt)."

  export DEBIAN_FRONTEND=noninteractive

  # --- Systempakete ------------------------------------------------------------------------------

  step "Systempakete installieren"
  # Eine vom Installationsmedium übrig gebliebene Paketquelle ("deb cdrom:") lässt apt sonst scheitern.
  if [ -f /etc/apt/sources.list ]; then
    sed -i 's/^deb cdrom:/# deb cdrom:/' /etc/apt/sources.list
  fi
  apt-get update -q
  apt-get install -y -q ca-certificates curl git jq unattended-upgrades

  # Die Uhr muss stimmen (Anmeldung mit zweitem Faktor). In einer virtuellen Maschine geht sie sonst
  # nach, z. B. nachdem der Gast-PC im Energiesparmodus war.
  time_sync=no
  for unit in systemd-timesyncd chrony chronyd ntpsec ntp; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then time_sync=yes; fi
  done
  if [ "$time_sync" = no ]; then
    apt-get install -y -q systemd-timesyncd
    systemctl enable --now systemd-timesyncd
  fi

  # Sicherheitsupdates des Systems täglich und von selbst.
  cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

  # --- Docker ------------------------------------------------------------------------------------

  if docker compose version >/dev/null 2>&1; then
    step "Docker ist schon installiert"
  else
    step "Docker installieren"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${CODENAME} stable" \
      >/etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi

  # Protokolle der Container begrenzen, sonst wachsen sie über Monate unbegrenzt.
  if [ ! -f /etc/docker/daemon.json ]; then
    mkdir -p /etc/docker
    cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
    systemctl restart docker
  fi
  systemctl enable --now docker >/dev/null

  # --- Tailscale ---------------------------------------------------------------------------------

  if command -v tailscale >/dev/null 2>&1; then
    step "Tailscale ist schon installiert"
  else
    step "Tailscale installieren"
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  systemctl enable --now tailscaled >/dev/null

  ts_state() { tailscale status --json 2>/dev/null | jq -r '.BackendState // ""'; }

  if [ "$(ts_state)" != Running ]; then
    step "Bei Tailscale anmelden"
    note "Gleich erscheint ein Link (und ein QR-Code). Öffne ihn auf dem Handy oder einem anderen"
    note "Gerät und melde dich an – mit demselben Konto, das du auch in der Tailscale-App nutzt."
    note "Neu bei Tailscale? Dann legst du dort jetzt kostenlos ein Konto an."
    tailscale up --qr --hostname="$TS_HOSTNAME" --accept-dns=false
  fi
  for _ in $(seq 1 30); do
    [ "$(ts_state)" = Running ] && break
    sleep 1
  done
  [ "$(ts_state)" = Running ] || fail "Tailscale ist nicht verbunden. Starte das Skript noch einmal."
  # Tailscale soll die Namensauflösung dieses Rechners nicht übernehmen. Der Hub braucht sie nicht,
  # und Container übernehmen /etc/resolv.conf nur beim Start: Schreibt Tailscale die Datei danach um,
  # findet der Hub keine Namen im Internet mehr (myGEKKO-Cloud, Spotify).
  tailscale set --accept-dns=false

  DOMAIN="$(tailscale status --json | jq -r '.Self.DNSName // ""')"
  DOMAIN="${DOMAIN%.}"
  case "$DOMAIN" in
    *.ts.net) ;;
    *) fail "Tailscale hat diesem Rechner keinen Namen gegeben. Schalte in der Tailscale-Verwaltung (login.tailscale.com › DNS) die Option MagicDNS ein und starte das Skript noch einmal." ;;
  esac

  step "https über Tailscale einschalten"
  note "Falls gleich ein Link erscheint: öffnen und HTTPS (bzw. Serve) erlauben."
  note "Das Skript wartet so lange."
  tailscale serve --bg 8080

  # --- Hub ---------------------------------------------------------------------------------------

  step "Hub holen"
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" pull --ff-only -q
  else
    if [ -n "$BRANCH" ]; then
      git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$DIR"
    else
      git clone -q --depth 1 "$REPO_URL" "$DIR"
    fi
  fi

  ENV_FILE="$DIR/deploy/.env"
  [ -f "$ENV_FILE" ] || cp "$DIR/deploy/.env.example" "$ENV_FILE"
  if grep -q '^HUB_DOMAIN=' "$ENV_FILE"; then
    sed -i "s|^HUB_DOMAIN=.*|HUB_DOMAIN=${DOMAIN}|" "$ENV_FILE"
  else
    printf 'HUB_DOMAIN=%s\n' "$DOMAIN" >>"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"

  step "Helfer für den Hub einrichten"
  # Zwei kleine Helfer auf diesem Rechner, damit der Hub selbst keine Rechte über ihn braucht:
  #  - Neustart auf Wunsch: Der Hub legt eine Anfrage in /var/lib/home-hub/control ab (Knopf
  #    „Server neu starten“ in der App), der Helfer startet den Rechner neu.
  #  - Namensserver abgleichen: Startet der Hub beim Hochfahren, bevor das Netz die Namensserver
  #    vergeben hat, findet er keine Namen im Internet. Der Helfer startet ihn dann einmal neu.
  local host="$DIR/deploy/linux/host"
  # Im Container läuft der Hub als Benutzer "node" (Kennung 1000).
  install -d -m 0750 -o 1000 -g 1000 /var/lib/home-hub/control
  printf '1\n' >/var/lib/home-hub/control/helper
  install -d -m 0755 /usr/local/lib/home-hub
  install -m 0755 "$host/home-hub-reboot.sh" "$host/home-hub-dns-sync.sh" /usr/local/lib/home-hub/
  for unit in home-hub-reboot.path home-hub-reboot.service home-hub-dns.path home-hub-dns.service home-hub-dns.timer; do
    install -m 0644 "$host/$unit" /etc/systemd/system/
  done
  systemctl daemon-reload
  systemctl enable --now home-hub-reboot.path home-hub-dns.path home-hub-dns.timer >/dev/null 2>&1
  cp "$host/docker-compose.override.yml" "$DIR/deploy/docker-compose.override.yml"

  step "Hub starten"
  cd "$DIR/deploy"
  # Tailscale übernimmt https – den mitgelieferten Proxy (Caddy) braucht es auf diesem Weg nicht.
  docker compose pull -q hub
  # Immer neu anlegen, damit der Container die aktuelle Namensauflösung des Rechners übernimmt.
  docker compose up -d --force-recreate hub

  healthy=no
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null http://127.0.0.1:8080/api/health 2>/dev/null; then
      healthy=yes
      break
    fi
    sleep 2
  done
  [ "$healthy" = yes ] || fail "Der Hub antwortet nicht. Protokoll ansehen:  cd $DIR/deploy && sudo docker compose logs hub"

  # --- Fertig ------------------------------------------------------------------------------------

  code="$(docker compose exec -T hub cat /data/setup-code.txt 2>/dev/null | tr -d '[:space:]' || true)"

  printf '\n%s%s%s\n' "$green" "Fertig – der Hub läuft." "$reset"
  printf '\n  Adresse:  %shttps://%s%s\n' "$bold" "$DOMAIN" "$reset"
  if [ -n "$code" ]; then
    printf '  Einrichtungscode:  %s%s%s\n' "$bold" "$code" "$reset"
    note ""
    note "Öffne die Adresse auf dem Handy (Tailscale-App muss verbunden sein), gib den Code ein"
    note "und lege dein Konto an. Der erste Aufruf kann ein paar Sekunden dauern, weil das"
    note "Zertifikat erst ausgestellt wird."
  fi
  note ""
  note "Aktualisieren:  sudo bash $DIR/deploy/linux/install.sh"
  note "Protokoll:      cd $DIR/deploy && sudo docker compose logs -f hub"
}

main "$@"
