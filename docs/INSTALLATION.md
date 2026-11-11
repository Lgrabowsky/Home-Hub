# Installation

Diese Anleitung bringt den Hub auf einem Rechner in deinem Heimnetz zum Laufen. Plane etwa eine
halbe Stunde ein.

## Schnellstart auf einem Windows-PC

Zum Ausprobieren – und für den Anfang auch mit deinen echten Geräten – gibt es ein fertiges
Windows-Paket: GitHub › Actions › „CI“ › neuester Lauf › Artifacts › `HomeHub-Windows`.
Entpacken, dann Doppelklick auf **„Demo starten.cmd“** (alle Geräte simuliert) oder
**„Home Hub starten.cmd“** (echte Geräte). Node.js und ffmpeg werden beim ersten Start per winget
installiert. Das Fenster zeigt die Adresse fürs Handy und den Einrichtungscode; alles Weitere steht in
`LIESMICH.txt` im Paket.

Vom Handy im selben WLAN geht es sofort im Browser (`http://<IP des PCs>:8080`). Die Android-App
braucht https – dafür Tailscale auf PC und Handy installieren (siehe [FERNZUGRIFF.md](FERNZUGRIFF.md));
das Startskript richtet `tailscale serve` dann selbst ein.

Für den Dauerbetrieb ist ein Rechner, der immer läuft, die bessere Wahl – weiter mit der Anleitung unten.

## 1. Was du brauchst

- **Einen Rechner, der immer an ist** und per Kabel oder stabilem WLAN im selben Netz wie deine
  Geräte hängt: Raspberry Pi 4/5 (ab 2 GB RAM, 64-Bit-System), ein NAS mit Docker (Synology, QNAP,
  Unraid …) oder ein Mini-PC. Linux wird empfohlen – unter Docker Desktop (Windows/macOS) findet der
  Hub die Lautsprecher nicht automatisch und Live-Video braucht Zusatzkonfiguration.
- **Docker** mit dem Compose-Plugin: <https://docs.docker.com/engine/install/>
- **Einen Namen, unter dem der Hub erreichbar ist** – den legst du in
  [FERNZUGRIFF.md](FERNZUGRIFF.md) fest (VPN-Name oder eigene Adresse). Lies das zuerst, es
  entscheidet, was du gleich in die Konfiguration schreibst.

## 2. Hub starten

```bash
git clone https://github.com/lgrabowsky/home-hub.git
cd home-hub/deploy
cp .env.example .env
```

Öffne `.env` und trage ein:

| Zeile | Bedeutung |
| --- | --- |
| `HUB_DOMAIN` | Name, unter dem der Hub erreichbar ist, ohne `https://` – z. B. `zuhause.example.de` oder `rechner.mein-netz.ts.net` |
| `HUB_WEBRTC_CANDIDATES` | Nur bei Zugriff direkt aus dem Internet: `<name>:8555` (siehe [FERNZUGRIFF.md](FERNZUGRIFF.md)). Bei VPN leer lassen. |
| `HUB_MASTER_KEY` | Optional. Leer lassen = der Hub erzeugt beim ersten Start selbst einen Schlüssel und legt ihn zu den Daten. Mehr dazu in [SICHERHEIT.md](SICHERHEIT.md#der-hauptschlüssel). |

Dann:

```bash
docker compose up -d --build
```

Der erste Start baut das Programm und dauert auf einem Raspberry Pi einige Minuten.

> Sobald das Projekt auf seinem Hauptzweig liegt, veröffentlicht GitHub fertige Abbilder
> (`ghcr.io/lgrabowsky/home-hub`). Dann genügt `docker compose pull && docker compose up -d`.

## 3. Erstes Konto anlegen

Beim allerersten Start erzeugt der Hub einen **Einrichtungscode** und schreibt ihn in sein Protokoll:

```bash
docker compose logs hub
```

Öffne `https://<dein HUB_DOMAIN>` im Browser, gib den Code ein und lege dein Konto an (Passwort mit
mindestens 10 Zeichen). Der Code gilt nur, solange es noch kein Konto gibt – danach ist die
Einrichtung für immer geschlossen.

Direkt danach richtest du den **zweiten Faktor** ein: QR-Code mit einer Authenticator-App scannen
(z. B. Aegis, 2FAS, Google Authenticator, Microsoft Authenticator) und die
**Wiederherstellungscodes aufschreiben** – sie sind der Weg zurück, wenn das Telefon verloren geht.

## 4. Geräte verbinden

In der App: **Mehr › Geräte & Dienste**. Für jedes Gerät steht dort, was vorzubereiten ist; die
ausführliche Fassung findest du in [GERAETE.md](GERAETE.md). Mit **Verbindung testen** prüfst du die
Eingaben, bevor du speicherst.

## 5. Weitere Personen einladen

**Mehr › Benutzer › Anlegen.** Du vergibst ein erstes Passwort und gibst es persönlich weiter; beim
ersten Anmelden richtet die Person ihren zweiten Faktor ein und kann das Passwort ändern.

| Rolle | Darf |
| --- | --- |
| Administrator | alles, auch Geräte und Benutzer verwalten |
| Mitglied | alles bedienen, nichts einstellen |
| Gast | nur, was du ankreuzt – z. B. Licht und Musik, aber keine Kameras und kein Türöffner |

## Aktualisieren

```bash
cd home-hub
git pull
cd deploy
docker compose up -d --build
```

Deine Daten bleiben erhalten (sie liegen im Volume `hub_data`).

## Sichern und wiederherstellen

Alles Wichtige liegt im Volume `hub_data`: Benutzer, Einstellungen (verschlüsselt), der Verlauf der
Türstationen und – wenn du `HUB_MASTER_KEY` nicht selbst gesetzt hast – der Hauptschlüssel
`master.key`.

Sichern (der Hub wird dafür kurz angehalten, damit die Datenbank in sich stimmig ist):

```bash
cd home-hub/deploy
docker compose stop hub
docker run --rm -v deploy_hub_data:/data -v "$PWD":/backup alpine \
  tar czf /backup/home-hub-sicherung-$(date +%F).tar.gz -C /data .
docker compose start hub
```

Wiederherstellen auf einem neuen Rechner: Projekt holen, `.env` anlegen, dann **vor** dem ersten Start

```bash
docker volume create deploy_hub_data
docker run --rm -v deploy_hub_data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/home-hub-sicherung-JJJJ-MM-TT.tar.gz -C /data
docker compose up -d --build
```

Hast du `HUB_MASTER_KEY` selbst gesetzt, gehört dieser Wert zwingend mit zur Sicherung – ohne ihn
lassen sich die gespeicherten Geräte-Zugangsdaten nicht mehr lesen (du müsstest sie neu eintragen).
Bewahre die Sicherung so sorgfältig auf wie einen Haustürschlüssel.

## Wenn etwas nicht klappt

| Symptom | Ursache und Abhilfe |
| --- | --- |
| Seite lädt nicht, Zertifikatsfehler | Der Proxy konnte kein Zertifikat holen: `docker compose logs caddy`. Bei eigener Adresse müssen die Ports 80 und 443 beim Hub ankommen, siehe [FERNZUGRIFF.md](FERNZUGRIFF.md). |
| „Keine Verbindung zum Hub“ in der App | Läuft der Hub? `docker compose ps`, `docker compose logs hub` |
| Einrichtungscode verloren | Er steht bei jedem Start erneut im Protokoll, solange noch kein Konto existiert. |
| Passwort **und** zweiter Faktor **und** Wiederherstellungscodes des einzigen Administrators verloren | Es gibt bewusst keine Hintertür. Daten sichern, Volume `hub_data` löschen, neu einrichten. |
| Ein Gerät ist „Nicht erreichbar“ | **Mehr › Diagnose** zeigt den Grund in Klartext; **Verbindung testen** in den Geräte-Einstellungen prüft Adresse und Zugangsdaten. |
| Kein Live-Bild von unterwegs, zu Hause geht es | Der Medien-Port ist von außen nicht erreichbar – siehe [FERNZUGRIFF.md](FERNZUGRIFF.md#live-video-und-gegensprechen). |
| Lautsprecher werden nicht gefunden | Der Hub muss im selben Netz (gleiches VLAN) wie die Lautsprecher hängen; sonst in **Geräte & Dienste › Lautsprecher** die IP-Adresse eines Lautsprechers eintragen. |

## Einstellungen des Hubs (Umgebungsvariablen)

Für die normale Installation genügt die Datei `.env`. Der Vollständigkeit halber:

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `HUB_PUBLIC_URL` | – | Adresse, unter der die App den Hub erreicht (`https://…`). Wird für sichere Cookies und die Spotify-Verknüpfung gebraucht. |
| `HUB_HOST` / `HUB_PORT` | `0.0.0.0` / `8080` | Woran der Hub lauscht. Hinter dem Proxy: `127.0.0.1`. |
| `HUB_TRUST_PROXY` | aus | `1`, wenn genau ein Proxy davor sitzt (damit die echte Adresse des Aufrufers im Protokoll steht und die Anmeldebremse richtig zählt). |
| `HUB_DATA_DIR` | `./data` | Datenverzeichnis |
| `HUB_MASTER_KEY` | – | Hauptschlüssel (32 zufällige Bytes, Base64); sonst `master.key` im Datenverzeichnis |
| `HUB_ALLOWED_ORIGINS` | – | Zusätzliche Web-Adressen, die den Hub mit einem Zugangstoken ansprechen dürfen (normalerweise nicht nötig) |
| `HUB_WEBRTC_PORT` | `8555` | Medien-Port (TCP und UDP) |
| `HUB_WEBRTC_CANDIDATES` | – | Von außen erreichbare Adressen des Medien-Ports, mit Komma getrennt |
| `HUB_WEBRTC_ICE_SERVERS` | – | Optionale STUN/TURN-Server. Standard: keine – es wird kein fremder Server kontaktiert. |
| `HUB_MEDIA` | `1` | `0` schaltet den Video-Dienst ab |
| `HUB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `HUB_DEMO` | aus | `1` = Demo mit simulierten Geräten |
| `HUB_SETUP_TOKEN` | – | Fester Einrichtungscode statt eines zufälligen (für automatisierte Installationen) |
