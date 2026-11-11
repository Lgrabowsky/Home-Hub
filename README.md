# Home Hub

**Eine App für dein ganzes Zuhause** – myGEKKO, DoorBird, Reolink, Sonos und Spotify in einer
einzigen, modernen Oberfläche. Als Web-App (im Browser, installierbar als PWA) und als Android-App.

Du schaltest Licht und Jalousien, siehst, welches Fenster offen ist, sprichst mit dem Besuch an der
Haustür, öffnest die Tür, schwenkst die Kamera im Garten und startest Musik im Wohnzimmer – ohne je
zu merken, dass dahinter fünf verschiedene Hersteller stecken.

> **Stand:** Die App ist vollständig gebaut und gegen originalgetreue Simulatoren aller Geräte
> getestet. An echter Hardware wurde sie noch **nicht** erprobt – siehe
> [Was du beim ersten Einsatz prüfen solltest](docs/GERAETE.md#checkliste-für-den-ersten-einsatz-an-echten-geräten).

## Was die App kann

| Bereich | Funktionen |
| --- | --- |
| **Räume** (myGEKKO) | Lichter (schalten, dimmen, Farbe), Jalousien und Rollläden (Position, Lamellen), Heizung je Raum, Steckdosen und Geräte, Szenen/Aktionen, Zeitschaltuhren, Wetterwerte |
| **Sicherheit** | Alle Fenster- und Türkontakte auf einen Blick („2 von 14 offen“), Zustand der Alarmüberwachung (Hülle), Live-Bilder aller Kameras und Türstationen |
| **Türstationen** (DoorBird) | Live-Video, Gegensprechen, Tür öffnen (mit Schiebe-Bestätigung), Licht, Verlauf mit Bildern (Klingeln, Bewegung, Öffnungen), Klingel-Meldung in der App |
| **Kameras** (Reolink) | Live-Video in HD/SD, Schwenken/Neigen/Zoomen, gespeicherte Positionen, Mithören, Gegensprechen, Scheinwerfer, Sirene |
| **Musik** (Sonos + Spotify) | Was läuft wo, Lautstärke, Räume gruppieren, Sonos-Favoriten, in Spotify suchen und stöbern und auf jedem Lautsprecher abspielen |
| **Verwaltung** | Benutzer und Rechte (z. B. „darf die Tür öffnen“), Geräte einrichten, Protokoll, Diagnose |

## So ist es aufgebaut

```
   Handy / Tablet / PC                          dein Zuhause
 ┌─────────────────────┐    HTTPS     ┌──────────────────────────────────────────┐
 │ Android-App / Web   │◄────────────►│  Home Hub (kleiner Server, Docker)       │
 │ (nichts gespeichert │   von überall│   ├─ Anmeldung, Rechte, Verschlüsselung  │
 │  außer der Anmeldung)│             │   ├─ myGEKKO   (Licht, Jalousien, …)     │
 └─────────────────────┘              │   ├─ DoorBird  (Türstationen)            │
                                      │   ├─ Reolink   (Kameras)                 │
                                      │   ├─ Sonos     (Lautsprecher)            │
                                      │   └─ Video-Dienst (go2rtc)               │
                                      └──────────────────────────────────────────┘
```

Der **Hub** läuft bei dir zu Hause (Raspberry Pi, NAS oder Mini-PC). Nur er spricht mit den Geräten
und nur er kennt deren Zugangsdaten. Die Apps sprechen ausschließlich mit dem Hub – verschlüsselt,
mit Anmeldung und zweitem Faktor. Es gibt keine Cloud dazwischen und keinen Dienst eines Dritten,
der deine Daten sieht.

## Ausprobieren ohne Hardware (Demo)

Mit Docker:

```bash
git clone https://github.com/lgrabowsky/home-hub.git && cd home-hub/deploy
docker compose -f docker-compose.demo.yml up --build
```

Dann <http://localhost:8080> öffnen und mit dem Einrichtungscode `DEMO-DEMO-DEMO` ein Konto anlegen.
Alle Geräte sind simuliert: ein Haus mit Lichtern, Jalousien, Heizung, Kontakten, zwei Türstationen,
drei Kameras, sechs Lautsprechern und einem Spotify-Konto.

Ohne Docker (Node.js ab 22.13, für Live-Video zusätzlich `go2rtc` und `ffmpeg` im Pfad):

```bash
npm ci
npm run demo
```

## Richtig installieren

1. **[Installation](docs/INSTALLATION.md)** – Hub auf einem Rechner im Heimnetz starten.
2. **[Geräte verbinden](docs/GERAETE.md)** – was an myGEKKO, DoorBird, Reolink, Sonos und Spotify
   vorzubereiten ist, inklusive der Fenster- und Türkontakte.
3. **[Zugriff von unterwegs](docs/FERNZUGRIFF.md)** – per VPN (empfohlen) oder über eine eigene Adresse.
4. **[Android-App](docs/ANDROID.md)** – APK herunterladen und installieren.

Zum Nachlesen: **[Sicherheit & Datenschutz](docs/SICHERHEIT.md)** · **[Entwicklung](docs/ENTWICKLUNG.md)**

## Sicherheit in Kürze

- Kein Zugriff ohne Anmeldung – **Passwort und zweiter Faktor** (Authenticator-App) für alle.
- **Rechte je Person**: Wer darf Kameras sehen, wer die Tür öffnen? Gäste sehen nur, was du freigibst.
- Zugangsdaten der Geräte liegen **verschlüsselt** auf dem Hub und verlassen ihn nie.
- Jede Türöffnung, Anmeldung und Änderung steht im **Protokoll**.
- Die App lädt **nichts von fremden Servern** – keine Schriften, keine Statistik, keine Werbung.
- Android: Anmeldung im geschützten Schlüsselspeicher, optionale **Sperre per Fingerabdruck**,
  kein Inhalt in der App-Übersicht, kein Cloud-Backup der App-Daten.

Details: [docs/SICHERHEIT.md](docs/SICHERHEIT.md)

## Was du wissen solltest

- **Du brauchst einen kleinen Rechner, der immer läuft** (z. B. Raspberry Pi 4/5 mit 2 GB RAM oder mehr,
  ein NAS mit Docker oder ein Mini-PC). Ohne ihn geht es nicht: Die Geräte sind nur aus deinem
  Heimnetz erreichbar, und irgendwo müssen Anmeldung und Verschlüsselung stattfinden.
- **Einzelne Fensterkontakte bei myGEKKO:** Der myGEKKO gibt seine Alarmüberwachung nach außen nur als
  Ganzes preis („Hülle: etwas ist offen“). Einzelne Kontakte zeigt die App, wenn sie am myGEKKO als
  eigenes Element lesbar sind. Was automatisch gefunden wird und wie du den Rest in zwei Minuten
  „anlernst“, steht in [docs/GERAETE.md](docs/GERAETE.md#fenster--und-türkontakte).
- **Spotify** verlangt eine eigene, kostenlose „Entwickler-App“ und ein Premium-Konto. Die
  Einrichtung dauert fünf Minuten und ist in der App Schritt für Schritt erklärt.
- **Gegensprechen über Kameras** funktioniert nur bei Reolink-Modellen mit Lautsprecher, die
  Zwei-Wege-Audio über RTSP anbieten. An DoorBird-Türstationen funktioniert es immer.

## Verzeichnisse

| Ordner | Inhalt |
| --- | --- |
| `hub/` | Der Server: Anmeldung, Rechte, Geräte-Anbindungen, Simulatoren, Tests |
| `web/` | Die App (React); `web/android/` ist die Android-Hülle (Capacitor) |
| `shared/` | Gemeinsame Typen – der Vertrag zwischen Hub und App |
| `deploy/` | Docker-Compose-Dateien und Proxy-Konfiguration |
| `docs/` | Anleitungen |
